use super::GatewayLogQuery;
use time::{Date, macros::format_description};

pub(super) fn validate(query: &GatewayLogQuery) -> anyhow::Result<Option<(Date, Date)>> {
    anyhow::ensure!(
        query
            .order
            .as_deref()
            .is_none_or(|value| matches!(value, "asc" | "desc")),
        "invalid order"
    );
    let parse = |value: &str| -> anyhow::Result<Date> {
        anyhow::ensure!(value.len() == 10, "invalid date; expected YYYY-MM-DD");
        Ok(Date::parse(
            value,
            format_description!("[year]-[month]-[day]"),
        )?)
    };
    match (&query.from, &query.to) {
        (None, None) => {
            if let Some(date) = &query.date {
                parse(date)?;
            }
            Ok(None)
        }
        (Some(from), Some(to)) => {
            anyhow::ensure!(query.date.is_none(), "from/to cannot be combined with date");
            let (from, to) = (parse(from)?, parse(to)?);
            anyhow::ensure!(
                from <= to && (to - from).whole_days() < 30,
                "date range must contain 1 to 30 days"
            );
            Ok(Some((from, to)))
        }
        _ => anyhow::bail!("from and to must be supplied together"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_calendar_dates_and_inclusive_thirty_day_limit() {
        for (from, to, valid) in [
            ("2026-01-01", "2026-01-30", true),
            ("2026-01-01", "2026-01-31", false),
            ("2026-02-29", "2026-03-01", false),
            ("2026-03-02", "2026-03-01", false),
        ] {
            let query = GatewayLogQuery {
                from: Some(from.into()),
                to: Some(to.into()),
                ..Default::default()
            };
            assert_eq!(validate(&query).is_ok(), valid);
        }
        assert!(
            validate(&GatewayLogQuery {
                from: Some("2026-01-01".into()),
                ..Default::default()
            })
            .is_err()
        );
        assert!(
            validate(&GatewayLogQuery {
                date: Some("2026-01-01".into()),
                from: Some("2026-01-01".into()),
                to: Some("2026-01-01".into()),
                ..Default::default()
            })
            .is_err()
        );
    }
}
