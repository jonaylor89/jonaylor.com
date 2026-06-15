use hub::configuration::get_configuration;
use hub::idempotency_cleanup::run_cleanup_worker;
use hub::issue_delivery_queue::run_worker_until_stopped;
use hub::memory::run_memory_worker_until_stopped;
use hub::rss_worker::run_rss_worker;
use hub::startup::Application;
use hub::telemetry::{get_subscriber, init_subscriber};
use std::fmt::{Debug, Display};
use tokio::task::JoinError;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let subscriber = get_subscriber("hub".into(), "info".into(), std::io::stdout);
    init_subscriber(subscriber);

    let configuration = get_configuration().expect("Failed to read configuration");

    let application = Application::build(configuration.clone()).await?;
    let application_task = tokio::spawn(application.run_until_stopped());

    let worker_task = tokio::spawn(run_worker_until_stopped(configuration.clone()));

    let cleanup_task = tokio::spawn(run_cleanup_worker(configuration.clone()));

    let rss_task = tokio::spawn(run_rss_worker(configuration.clone()));

    let memory_task = tokio::spawn(run_memory_worker_until_stopped(configuration));

    tokio::select! {
        o = application_task => report_exit("API", o),
        o = worker_task => report_exit("Background worker", o),
        o = cleanup_task => report_exit("Idempotency cleanup worker", o),
        o = rss_task => report_exit("RSS worker", o),
        o = memory_task => report_exit("Memory extraction worker", o),
    };

    Ok(())
}

fn report_exit(task_name: &str, outcome: Result<Result<(), impl Debug + Display>, JoinError>) {
    match outcome {
        Ok(Ok(())) => {
            tracing::info!("{} has exited", task_name)
        }
        Ok(Err(e)) => {
            tracing::error!(
                error.cause_chain = ?e,
                error.message = %e,
                "{} failed",
                task_name,
            )
        }
        Err(e) => {
            tracing::error!(
                error.cause_chain = ?e,
                error.message = %e,
                "'{}' tasks failed to complete",
                task_name,
            )
        }
    }
}
