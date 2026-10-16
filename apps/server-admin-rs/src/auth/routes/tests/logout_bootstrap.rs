use super::*;

const TARGET: &str = "https://app.example.com/private?tab=files";

async fn request_bootstrap(state: &AppState, host: &str, ip: &str, flag: Option<&str>) -> Value {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("redirect_uri", TARGET);
    if let Some(flag) = flag {
        query.append_pair("logged_out", flag);
    }
    let response = Router::new()
        .nest("/api/auth", auth_api_routes())
        .with_state(state.clone())
        .oneshot(
            Request::get(format!("/api/auth/bootstrap?{}", query.finish()))
                .header("x-forwarded-host", host)
                .header("x-forwarded-proto", "https")
                .header("x-forwarded-for", ip)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers()[header::CACHE_CONTROL]
            .to_str()
            .unwrap()
            .contains("no-store")
    );
    response_json(response).await["data"].clone()
}

#[tokio::test]
async fn logout_bootstrap_moves_to_auth_origin_without_changing_access() {
    for grant in [
        "anonymous",
        "local_exempt",
        "manual_whitelist",
        "login_ip_grant",
    ] {
        let (_directory, state) = auth_route_test_state(grant).await;
        let ip = if grant == "local_exempt" {
            "192.168.31.20"
        } else {
            "203.0.113.30"
        };
        if matches!(grant, "manual_whitelist" | "login_ip_grant") {
            if grant == "login_ip_grant" {
                state
                    .storage
                    .store
                    .add_totp(TotpCredential {
                        id: "totp-1".into(),
                        secret: "secret".into(),
                        comment: "Test".into(),
                        created_at: time_utils::now_iso(),
                        access_scopes: Value::Null,
                        subdomain_access: json!({"mode": "all"}),
                    })
                    .await
                    .unwrap();
                let mut session = auth_route_test_session(ip, &time_utils::iso_after_seconds(3600));
                session.grant_type = Some(grant.into());
                session.post_login_ip_grant_mode = Some("follow_session".into());
                state
                    .storage
                    .store
                    .add_session("logout-bootstrap-owner", &session, 3600)
                    .await
                    .unwrap();
            }
            let now = time_utils::now_ms().div_euclid(1000);
            state
                .storage
                .store
                .insert_whitelist_record(&crate::store::WhitelistRecord {
                    id: format!("{grant}-record"),
                    ip: ip.into(),
                    target_type: "ip".into(),
                    expire_at: Some(now + 3600),
                    source: if grant == "manual_whitelist" {
                        "manual"
                    } else {
                        "auto"
                    }
                    .into(),
                    created_at: now,
                    status: "active".into(),
                    comment: None,
                    ip_location: None,
                    resolved_targets: None,
                    check_interval_minutes: None,
                    last_checked_at: None,
                    last_resolved_at: None,
                    resolve_status: None,
                    resolve_message: None,
                })
                .await
                .unwrap();
            crate::whitelist::rebuild_whitelist_ipset_snapshots(&state)
                .await
                .unwrap();
        }
        let before = request_bootstrap(&state, "app.example.com", ip, None).await;
        let logged_out = request_bootstrap(&state, "app.example.com", ip, Some("1")).await;
        assert_eq!(logged_out["auth"], before["auth"], "{grant}");
        assert_eq!(
            logged_out["auth"]["authenticated"],
            grant != "anonymous",
            "{grant}"
        );
        if grant != "anonymous" {
            assert_eq!(logged_out["auth"]["grant_type"], grant);
            assert_eq!(before["redirect_kind"], "authenticated");
            assert_eq!(before["redirect_to"], TARGET);
        }
        assert_eq!(logged_out["redirect_kind"], "login");
        let login = url::Url::parse(logged_out["redirect_to"].as_str().unwrap()).unwrap();
        assert_eq!(login.host_str(), Some("auth.example.com"));
        assert_eq!(login.fragment(), Some("/login"));
        assert!(
            login
                .query_pairs()
                .any(|(k, v)| k == "logged_out" && v == "1")
        );
        assert!(
            login
                .query_pairs()
                .any(|(k, v)| k == "redirect_uri" && v == TARGET)
        );
        let arrived = request_bootstrap(&state, "auth.example.com", ip, Some("1")).await;
        assert!(arrived.get("redirect_to").is_none(), "{grant}: {arrived}");
        assert!(arrived.get("redirect_kind").is_none());
        let other = request_bootstrap(&state, "app.example.com", ip, Some("3")).await;
        assert_eq!(other["redirect_to"], before["redirect_to"]);
        assert_eq!(other["redirect_kind"], before["redirect_kind"]);
    }
}

#[test]
fn logout_bootstrap_preserves_service_local_login_and_cookie_boundaries() {
    let mut config = shared_auth_test_config();
    config["host_mappings"] = json!([
        {"host": "app.example.com", "use_auth": true},
        {"host": "other.example.net", "use_auth": true}
    ]);
    for (cookie_domain, target) in [
        ("", "https://other.example.net/private?tab=files"),
        ("auth.example.com", TARGET),
    ] {
        config["subdomain_mode"]["cookie_domain"] = json!(cookie_domain);
        let login = bootstrap_login_redirect(
            &config,
            &forwarded_headers("auth.example.com"),
            Some(target),
            true,
            None,
        )
        .unwrap();
        let parsed = url::Url::parse(&login).unwrap();
        let destination = url::Url::parse(target).unwrap();
        assert_eq!(parsed.origin(), destination.origin());
        assert_eq!(parsed.path(), "/__auth__/login");
        assert!(
            parsed
                .query_pairs()
                .any(|(k, v)| k == "logged_out" && v == "1")
        );
        assert!(
            parsed
                .query_pairs()
                .any(|(k, v)| k == "redirect_uri" && v == target)
        );
        assert!(
            bootstrap_login_redirect(
                &config,
                &forwarded_headers(destination.host_str().unwrap()),
                Some(target),
                true,
                None
            )
            .is_none()
        );
    }
}

#[test]
fn logout_bootstrap_drops_unsafe_return_targets() {
    for target in [
        "https://evil.invalid/",
        "//evil.invalid/",
        "javascript:alert(1)",
    ] {
        let login = bootstrap_login_redirect(
            &shared_auth_test_config(),
            &forwarded_headers("app.example.com"),
            Some(target),
            true,
            None,
        )
        .unwrap();
        let login = url::Url::parse(&login).unwrap();
        assert!(!login.query_pairs().any(|(k, _)| k == "redirect_uri"));
        assert!(
            login
                .query_pairs()
                .any(|(k, v)| k == "logged_out" && v == "1")
        );
    }
}

#[test]
fn logout_bootstrap_preserves_flow_only_when_valid_and_logged_out() {
    let flow = "ab000000-0000-4000-8000-000000000001";
    for (logged_out, value, expected) in [
        (true, flow, Some(flow)),
        (true, "invalid", None),
        (false, flow, None),
    ] {
        let login = bootstrap_login_redirect(
            &shared_auth_test_config(),
            &forwarded_headers("app.example.com"),
            Some(TARGET),
            logged_out,
            Some(value),
        )
        .unwrap();
        let url = url::Url::parse(&login).unwrap();
        assert_eq!(
            url.query_pairs()
                .find(|(k, _)| k == "logout_flow")
                .map(|(_, v)| v.into_owned())
                .as_deref(),
            expected
        );
    }
    let target = url::Url::parse(&format!(
        "https://app.example.com/__auth__/login?logged_out=1&logout_flow={flow}"
    ))
    .unwrap();
    let normalized = normalize_post_logout_redirect_target(&target);
    assert!(
        !normalized
            .query_pairs()
            .any(|(k, _)| k == "logout_flow" || k == "logged_out")
    );
}

#[tokio::test]
async fn logout_response_supports_json_without_changing_browser_redirect_or_failure() {
    let uri = Uri::from_static("/api/auth/logout");
    for accept in ["text/html", "application/json"] {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT, accept.parse().unwrap());
        headers.insert(
            header::REFERER,
            "https://app.example.com/__auth__/".parse().unwrap(),
        );
        let response = post_logout_response(&headers, &uri, false);
        let location = if accept == "application/json" {
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
            assert!(!response.headers().contains_key(header::LOCATION));
            response_json(response).await["data"]["redirect_to"]
                .as_str()
                .unwrap()
                .to_string()
        } else {
            assert_eq!(response.status(), StatusCode::FOUND);
            response.headers()[header::LOCATION]
                .to_str()
                .unwrap()
                .to_string()
        };
        let url = url::Url::parse(&format!("https://app.example.com{location}")).unwrap();
        assert_eq!(url.path(), "/__auth__/login");
        assert!(
            url.query_pairs()
                .any(|(k, v)| k == "logged_out" && v == "1")
        );
        assert!(
            url.query_pairs()
                .any(|(k, v)| k == "logout_flow" && uuid::Uuid::parse_str(&v).is_ok())
        );
        let failed = post_logout_response(&headers, &uri, true);
        assert_eq!(failed.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(!failed.headers().contains_key(header::LOCATION));
    }
}
