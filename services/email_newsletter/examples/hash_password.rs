use argon2::password_hash::SaltString;
use argon2::{Algorithm, Argon2, Params, PasswordHasher, Version};

fn main() {
    let password = std::env::args()
        .nth(1)
        .expect("Usage: hash_password <password>");

    let salt = SaltString::generate(&mut rand::thread_rng());
    let hash = Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(15_000, 2, 1, None).unwrap(),
    )
    .hash_password(password.as_bytes(), &salt)
    .unwrap()
    .to_string();

    println!("{hash}");
}
