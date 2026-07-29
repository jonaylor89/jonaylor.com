use axum::body::Body;
use axum::response::Response;
use http::StatusCode;
use http_body_util::BodyExt;
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use super::IdempotencyKey;

pub enum NextAction {
    StartProcessing(Transaction<'static, Sqlite>),
    ReturnSavedResponse(Response),
}

/// Serializable header pair for JSON storage.
/// Values are base64-encoded because they may contain arbitrary bytes.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct HeaderPairRecord {
    name: String,
    value: String, // base64-encoded
}

pub async fn get_saved_response(
    pool: &SqlitePool,
    idempotency_key: &IdempotencyKey,
    user_id: Uuid,
) -> Result<Option<Response>, anyhow::Error> {
    let user_id_str = user_id.to_string();
    let key_str = idempotency_key.as_ref();
    let saved_response = sqlx::query!(
        r#"
        SELECT
            response_status_code AS "response_status_code!",
            response_headers AS "response_headers!",
            response_body AS "response_body!"
        FROM idempotency
        WHERE
            user_id = ?
        AND
            idempotency_key = ?
        "#,
        user_id_str,
        key_str,
    )
    .fetch_optional(pool)
    .await?;

    if let Some(r) = saved_response {
        let status_code = StatusCode::from_u16(r.response_status_code.try_into()?)?;
        let mut builder = http::Response::builder().status(status_code);

        let headers: Vec<HeaderPairRecord> =
            serde_json::from_str(&r.response_headers).unwrap_or_default();
        for pair in headers {
            let value_bytes = base64::decode(&pair.value).unwrap_or_default();
            builder = builder.header(pair.name, value_bytes);
        }

        let response = builder
            .body(Body::from(r.response_body))
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        Ok(Some(response))
    } else {
        Ok(None)
    }
}

pub async fn save_response(
    mut transaction: Transaction<'static, Sqlite>,
    idempotency_key: &IdempotencyKey,
    user_id: Uuid,
    http_response: Response,
) -> Result<Response, anyhow::Error> {
    let (response_head, body) = http_response.into_parts();

    let body = body
        .collect()
        .await
        .map_err(|e| anyhow::anyhow!("{}", e))?
        .to_bytes();
    let status_code = response_head.status.as_u16() as i32;
    let user_id_str = user_id.to_string();

    let headers_json = {
        let pairs: Vec<HeaderPairRecord> = response_head
            .headers
            .iter()
            .map(|(name, value)| HeaderPairRecord {
                name: name.as_str().to_owned(),
                value: base64::encode(value.as_bytes()),
            })
            .collect();
        serde_json::to_string(&pairs)?
    };

    let body_bytes = body.to_vec();
    let key_str = idempotency_key.as_ref();

    sqlx::query!(
        r#"
        UPDATE idempotency
        SET
            response_status_code = ?,
            response_headers = ?,
            response_body = ?
        WHERE
            user_id = ?
        AND
            idempotency_key = ?
        "#,
        status_code,
        headers_json,
        body_bytes,
        user_id_str,
        key_str,
    )
    .execute(transaction.as_mut())
    .await?;
    transaction.commit().await?;

    let http_response = Response::from_parts(response_head, Body::from(body.clone()));
    Ok(http_response)
}

pub async fn try_processing(
    pool: &SqlitePool,
    idempotency_key: &IdempotencyKey,
    user_id: Uuid,
) -> Result<NextAction, anyhow::Error> {
    let mut transaction = pool.begin().await?;
    let user_id_str = user_id.to_string();
    let key_str = idempotency_key.as_ref();
    let now = chrono::Utc::now().to_rfc3339();
    let n_inserted_rows = sqlx::query!(
        r#"
        INSERT INTO idempotency (
            user_id,
            idempotency_key,
            created_at
        ) VALUES (
            ?,
            ?,
            ?
        ) ON CONFLICT DO NOTHING
        "#,
        user_id_str,
        key_str,
        now,
    )
    .execute(transaction.as_mut())
    .await?
    .rows_affected();

    if n_inserted_rows > 0 {
        Ok(NextAction::StartProcessing(transaction))
    } else {
        let saved_response = get_saved_response(pool, idempotency_key, user_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("No saved response found"))?;

        Ok(NextAction::ReturnSavedResponse(saved_response))
    }
}
