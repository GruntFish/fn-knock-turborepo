use std::{env, fs, path::PathBuf};

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use serde_json::Value;
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::proxy_utils::is_reverse_proxy_subdomain_mode;
use crate::{i18n::Translator, response, state::AppState};

fn system_info_route_text(translator: &Translator, key: &str) -> String {
    translator.t(&format!("server.systemInfoRoutes.{key}"))
}

#[derive(Debug, Serialize, PartialEq)]
struct AccessEntryInfo {
    env: &'static str,
    port: String,
    #[serde(rename = "isDefault")]
    is_default: bool,
}

pub fn system_info_routes() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(access_entry))
}

#[utoipa::path(
    get,
    path = "/api/admin/system/access-entry",
    tag = "system",
    operation_id = "get_api_admin_system_access_entry",
    responses((status = 200, description = "Resolved public management access entry"))
)]
async fn access_entry(State(state): State<AppState>) -> Response {
    match state.storage.store.get_config().await {
        Ok(config) => response::ok(resolve_access_entry_info(&config)).into_response(),
        Err(error) => {
            let translator = Translator::from_state(&state).await;
            tracing::warn!(%error, "failed to load config for access entry");
            response::error(
                StatusCode::INTERNAL_SERVER_ERROR,
                system_info_route_text(&translator, "loadAccessEntryFailed"),
            )
        }
    }
}

fn resolve_access_entry_info(config: &Value) -> AccessEntryInfo {
    resolve_access_entry_info_from_sources(
        config,
        resolve_frpc_remote_port(),
        env::var("GO_REPROXY_PORT").ok(),
    )
}

fn resolve_access_entry_info_from_sources(
    config: &Value,
    frpc_remote_port: Option<u16>,
    local_gateway_port: Option<String>,
) -> AccessEntryInfo {
    // Path links keep the administration hostname, so a remote FRP port would
    // incorrectly pair a NAS LAN address with a port listening on the FRP server.
    if is_reverse_proxy_subdomain_mode(config)
        && config
            .get("default_tunnel")
            .and_then(Value::as_str)
            .unwrap_or("frp")
            == "frp"
        && let Some(port) = frpc_remote_port
    {
        return AccessEntryInfo {
            env: "FRP_REMOTE_PORT",
            port: port.to_string(),
            is_default: false,
        };
    }
    resolve_local_gateway_port_from_env(local_gateway_port)
}

pub(crate) fn resolve_public_gateway_port(config: &Value) -> Option<i64> {
    resolve_public_gateway_port_from_sources(
        config,
        resolve_frpc_remote_port(),
        env::var("GO_REPROXY_PORT").ok(),
    )
}

pub(crate) fn resolve_public_gateway_port_u16(config: &Value) -> Option<u16> {
    resolve_public_gateway_port(config).and_then(|port| u16::try_from(port).ok())
}

pub(crate) fn resolve_access_entry_port(config: &Value) -> String {
    resolve_access_entry_info(config).port
}

fn resolve_public_gateway_port_from_sources(
    config: &Value,
    frpc_remote_port: Option<u16>,
    local_gateway_port: Option<String>,
) -> Option<i64> {
    parse_public_gateway_port(
        &resolve_access_entry_info_from_sources(config, frpc_remote_port, local_gateway_port).port,
    )
}

fn parse_public_gateway_port(value: &str) -> Option<i64> {
    parse_js_parse_int_radix_10(value.trim_start()).filter(|port| *port > 0)
}

fn resolve_local_gateway_port_from_env(value: Option<String>) -> AccessEntryInfo {
    match value.filter(|value| !value.is_empty()) {
        Some(port) => AccessEntryInfo {
            env: "GO_REPROXY_PORT",
            port,
            is_default: false,
        },
        None => AccessEntryInfo {
            env: "GO_REPROXY_PORT",
            port: "7999".to_string(),
            is_default: true,
        },
    }
}

fn resolve_frpc_remote_port() -> Option<u16> {
    let content = fs::read_to_string(data_dir().join("frp").join("frpc.toml")).ok()?;
    let local_port = env::var("GO_REPROXY_PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(7999);
    extract_frpc_remote_port(&content, local_port)
}

fn extract_frpc_remote_port(content: &str, local_port: u16) -> Option<u16> {
    let document = toml::from_str::<toml::Value>(content).ok()?;
    let proxies = document.get("proxies")?.as_array()?;
    let gateway_proxies = proxies.iter().filter(|proxy| {
        proxy
            .get("type")
            .and_then(toml::Value::as_str)
            .unwrap_or("tcp")
            == "tcp"
            && proxy
                .get("localPort")
                .or_else(|| proxy.get("local_port"))
                .and_then(toml::Value::as_integer)
                == Some(i64::from(local_port))
    });
    // Prefer the editor's managed proxy only when it forwards this gateway.
    // Custom names work too, but ambiguous mappings must not select another app.
    let proxy = gateway_proxies
        .clone()
        .find(|proxy| proxy.get("name").and_then(toml::Value::as_str) == Some("reproxy"))
        .or_else(|| {
            let mut candidates = gateway_proxies;
            let first = candidates.next()?;
            if candidates.next().is_some() {
                None
            } else {
                Some(first)
            }
        })?;
    let port = proxy
        .get("remotePort")
        .or_else(|| proxy.get("remote_port"))?
        .as_integer()?;
    u16::try_from(port).ok().filter(|port| *port > 0)
}

use crate::node_compat::parse_i64_prefix as parse_js_parse_int_radix_10;

fn data_dir() -> PathBuf {
    if let Ok(path) = env::var("FN_KNOCK_DATA_DIR") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    let home = env::var("HOME").unwrap_or_else(|_| ".".to_string());
    match env::consts::OS {
        "macos" => PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("fn-knock"),
        "linux" => PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("fn-knock"),
        _ => PathBuf::from(home).join(".fn-knock"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_managed_frpc_remote_port_from_toml() {
        for (value, expected) in [
            ("remotePort = 27999", Some(27999)),
            ("remote_port = 443", Some(443)),
            ("remotePort = 27_999 # public port", Some(27999)),
            ("remotePort = 70000", None),
            ("remotePort = 0", None),
            ("remotePort = -1", None),
            ("remotePort = 1.5", None),
            ("remotePort = \"27999\"", None),
        ] {
            assert_eq!(
                extract_frpc_remote_port(&format!("[[proxies]]\nlocalPort = 7999\n{value}"), 7999),
                expected
            );
        }
        assert_eq!(extract_frpc_remote_port("invalid TOML", 7999), None);
        assert_eq!(extract_frpc_remote_port("serverPort = 7000", 7999), None);
        assert_eq!(
            extract_frpc_remote_port(
                "[[proxies]]\nname = 'other'\nremotePort = 7999\n\
             [[proxies]]\nname = 'reproxy'\nlocalPort = 7999\nremotePort = 27999",
                7999
            ),
            Some(27999)
        );
    }

    #[test]
    fn selects_only_tcp_proxies_for_the_current_gateway() {
        let content = "[[proxies]]\nname = 'ssh'\ntype = 'tcp'\nlocalPort = 22\nremotePort = 22022\n\
            [[proxies]]\nname = 'custom-gateway'\ntype = 'tcp'\nlocal_port = 17999\nremote_port = 27999";
        assert_eq!(extract_frpc_remote_port(content, 17999), Some(27999));
        assert_eq!(extract_frpc_remote_port(content, 7999), None);
        assert_eq!(
            extract_frpc_remote_port(
                "[[proxies]]\nname = 'reproxy'\ntype = 'udp'\nlocalPort = 7999\nremotePort = 27999",
                7999,
            ),
            None
        );
        assert_eq!(
            extract_frpc_remote_port(
                "[[proxies]]\nname = 'reproxy'\nlocalPort = 22\nremotePort = 22022",
                7999,
            ),
            None
        );
    }

    #[test]
    fn does_not_guess_between_multiple_gateway_mappings() {
        let content = "[[proxies]]\nname = 'first'\nlocalPort = 7999\nremotePort = 27999\n\
            [[proxies]]\nname = 'second'\nlocalPort = 7999\nremotePort = 37999";
        assert_eq!(extract_frpc_remote_port(content, 7999), None);
        assert_eq!(
            extract_frpc_remote_port(&content.replace("'second'", "'reproxy'"), 7999,),
            Some(37999)
        );
    }

    #[test]
    fn keeps_path_entries_local_and_resolves_frp_host_entries() {
        for (submode, tunnel, expected_port, expected_env) in [
            ("path", "frp", "7999", "GO_REPROXY_PORT"),
            ("path", "cloudflared", "7999", "GO_REPROXY_PORT"),
            ("subdomain", "frp", "27999", "FRP_REMOTE_PORT"),
            ("subdomain", "cloudflared", "7999", "GO_REPROXY_PORT"),
        ] {
            let config = json!({
                "run_type": 1,
                "reverse_proxy_submode": submode,
                "default_tunnel": tunnel,
            });
            let entry = resolve_access_entry_info_from_sources(
                &config,
                Some(27999),
                Some("7999".to_string()),
            );
            assert_eq!(entry.port, expected_port);
            assert_eq!(entry.env, expected_env);
        }
        let direct = json!({"run_type": 3, "default_tunnel": "frp"});
        assert_eq!(
            resolve_access_entry_info_from_sources(&direct, Some(27999), Some("8443".to_string()),)
                .port,
            "8443"
        );
    }

    #[test]
    fn detects_reverse_proxy_subdomain_mode() {
        assert!(is_reverse_proxy_subdomain_mode(&json!({
            "run_type": 1,
            "reverse_proxy_submode": "subdomain"
        })));
        assert!(!is_reverse_proxy_subdomain_mode(&json!({
            "run_type": 3,
            "reverse_proxy_submode": "subdomain"
        })));
    }

    #[test]
    fn resolves_local_gateway_port_with_node_env_truthiness() {
        assert_eq!(
            resolve_local_gateway_port_from_env(None),
            AccessEntryInfo {
                env: "GO_REPROXY_PORT",
                port: "7999".to_string(),
                is_default: true
            }
        );
        assert_eq!(
            resolve_local_gateway_port_from_env(Some(String::new())),
            AccessEntryInfo {
                env: "GO_REPROXY_PORT",
                port: "7999".to_string(),
                is_default: true
            }
        );
        assert_eq!(
            resolve_local_gateway_port_from_env(Some("   ".to_string())),
            AccessEntryInfo {
                env: "GO_REPROXY_PORT",
                port: "   ".to_string(),
                is_default: false
            }
        );
        assert_eq!(
            resolve_local_gateway_port_from_env(Some(" 8000 ".to_string())),
            AccessEntryInfo {
                env: "GO_REPROXY_PORT",
                port: " 8000 ".to_string(),
                is_default: false
            }
        );
    }

    #[test]
    fn resolves_public_gateway_port_from_access_entry_like_node() {
        let direct = json!({ "run_type": 0 });
        assert_eq!(
            resolve_public_gateway_port_from_sources(
                &direct,
                Some(443),
                Some(" 8000x ".to_string())
            ),
            Some(8000)
        );
        assert_eq!(
            resolve_public_gateway_port_from_sources(&direct, None, Some("   ".to_string())),
            None
        );

        let reverse_subdomain = json!({
            "run_type": 1,
            "reverse_proxy_submode": "subdomain"
        });
        assert_eq!(
            resolve_access_entry_info_from_sources(
                &reverse_subdomain,
                Some(443),
                Some("7999".to_string())
            ),
            AccessEntryInfo {
                env: "FRP_REMOTE_PORT",
                port: "443".to_string(),
                is_default: false
            }
        );
        assert_eq!(
            resolve_public_gateway_port_from_sources(
                &reverse_subdomain,
                Some(443),
                Some("7999".to_string())
            ),
            Some(443)
        );
        assert_eq!(
            resolve_public_gateway_port_from_sources(
                &reverse_subdomain,
                None,
                Some("7999".to_string())
            ),
            Some(7999)
        );

        let cloudflared_reverse_subdomain = json!({
            "run_type": 1,
            "reverse_proxy_submode": "subdomain",
            "default_tunnel": "cloudflared"
        });
        assert_eq!(
            resolve_access_entry_info_from_sources(
                &cloudflared_reverse_subdomain,
                Some(15101),
                Some("7999".to_string())
            ),
            AccessEntryInfo {
                env: "GO_REPROXY_PORT",
                port: "7999".to_string(),
                is_default: false
            }
        );
        assert_eq!(
            resolve_public_gateway_port_from_sources(
                &cloudflared_reverse_subdomain,
                Some(15101),
                Some("7999".to_string())
            ),
            Some(7999)
        );
    }

    #[test]
    fn localizes_system_info_route_text() {
        let zh = Translator::new("zh-CN");
        assert_eq!(
            system_info_route_text(&zh, "loadAccessEntryFailed"),
            "加载访问入口失败"
        );
    }
}
