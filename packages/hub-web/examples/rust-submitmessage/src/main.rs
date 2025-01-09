mod message; // Generated protobuf code
mod username_proof; // Generated protobuf code

use ed25519_dalek::{SecretKey, Signer, SigningKey};
use hex::FromHex;
use reqwest::Client;

use message::{CastAddBody, FarcasterNetwork, MessageData};
use protobuf::Message;

const FARCASTER_EPOCH: u64 = 1609459200; // January 1, 2021 UTC

#[tokio::main]
async fn main() {
    let fid = 6833; // FID of the user submitting the message
    let network = FarcasterNetwork::FARCASTER_NETWORK_MAINNET;

    // Construct the cast add message
    let mut cast_add = CastAddBody::new();
    cast_add.set_text("Welcome to Rust!".to_string());

    // Construct the cast add message data object
    let mut msg_data = MessageData::new();
    msg_data.set_field_type(message::MessageType::MESSAGE_TYPE_CAST_ADD);
    msg_data.set_fid(fid);
    // Set the timestamp to the current time
    msg_data.set_timestamp(
        (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - FARCASTER_EPOCH) as u32,
    );
    msg_data.set_network(network);
    msg_data.set_cast_add_body(cast_add);

    let msg_data_bytes = msg_data.write_to_bytes().unwrap();
    // Calculate the blake3 hash, truncated to 20 bytes
    let hash = blake3::hash(&msg_data_bytes).as_bytes()[0..20].to_vec();

    // Construct the actual message
    let mut msg = message::Message::new();
    msg.set_hash_scheme(message::HashScheme::HASH_SCHEME_BLAKE3);
    msg.set_hash(hash);

    // Sign the message. You need to use a signing key that corresponds to the FID you are adding.
    // REPLACE THE PRIVATE KEY WITH YOUR OWN
    let private_key = SigningKey::from_bytes(
        &SecretKey::from_hex("0x...").expect("Please provide a valid private key"),
    );
    let signature = private_key.sign(&hash).to_bytes();

    msg.set_signature_scheme(message::SignatureScheme::SIGNATURE_SCHEME_ED25519);
    msg.set_signature(signature.to_vec());
    msg.set_signer(private_key.verifying_key().to_bytes().to_vec());

    // Serialize the message
    msg.set_data_bytes(msg_data_bytes.to_vec());
    let msg_bytes = msg.write_to_bytes().unwrap();

    // Finally, submit the message to the network

    // Create a reqwest Client
    let client = Client::new();

    // Define your endpoint URL
    let url = "http://127.0.0.1:2281/v1/submitMessage";

    // Make the POST request
    let res = client
        .post(url)
        .header("Content-Type", "application/octet-stream")
        .body(msg_bytes)
        .send()
        .await
        .unwrap();

    // Check if it's success
    if res.status().is_success() {
        println!("Successfully sent the message.");
    } else {
        println!("Failed to send the message. HTTP status: {}", res.status());
    }
}
