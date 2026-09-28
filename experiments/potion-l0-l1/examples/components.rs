//! Times the helper's components on real texts, in-process:
//! per-text vs batched tokenization, model encode_batch, JSON output.
//!
//!   node scripts/perf/potion-throughput.cjs texts <repo> /tmp/texts.json
//!   cargo run --release --example components -- /tmp/texts.json ../../packages/mcp/assets/potion/linux-x64/model
use std::{path::Path, time::Instant};

use satori_potion_l0_l1::StrictPotionModel;
use tokenizers::Tokenizer;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let texts: Vec<String> = serde_json::from_str(&std::fs::read_to_string(&args[1]).expect("texts file")).expect("texts json");
    let model_dir = Path::new(&args[2]);
    let megabytes = texts.iter().map(|text| text.len()).sum::<usize>() as f64 / 1e6;
    let report = |name: &str, started: Instant| {
        let seconds = started.elapsed().as_secs_f64();
        println!("{name:<24} {seconds:.3}s {:.2} MB/s", megabytes / seconds);
    };

    let tokenizer = Tokenizer::from_file(model_dir.join("tokenizer.json")).expect("tokenizer");
    let started = Instant::now();
    for text in &texts {
        tokenizer.encode(text.as_str(), false).expect("encode");
    }
    report("tokenize per-text", started);
    let started = Instant::now();
    for batch in texts.chunks(64) {
        tokenizer.encode_batch_fast(batch.iter().map(|text| text.as_str()).collect::<Vec<_>>(), false).expect("encode");
    }
    report("tokenize batch64 fast", started);

    let model = StrictPotionModel::load(model_dir, 4096).expect("model");
    let started = Instant::now();
    let mut vectors = Vec::new();
    for batch in texts.chunks(64) {
        vectors.push(model.encode_batch(batch).expect("encode_batch").into_iter().map(|item| item.vector).collect::<Vec<_>>());
    }
    report("model encode_batch64", started);

    let started = Instant::now();
    let bytes: usize = vectors.iter().map(|batch| serde_json::to_vec(batch).expect("json").len()).sum();
    println!("{:<24} {:.3}s {bytes} bytes", "json compact", started.elapsed().as_secs_f64());
}
