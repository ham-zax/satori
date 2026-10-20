use super::*;
use std::process::Command;

#[test]
fn rejects_zero_nonfinite_and_wrong_dimension_vectors() {
    assert_eq!(
        validate_vector(&vec![0.0; EXPECTED_DIMENSION], EXPECTED_DIMENSION),
        Err(StrictEncodeError::ZeroNormOutput),
    );
    assert_eq!(
        validate_vector(&vec![f32::INFINITY; EXPECTED_DIMENSION], EXPECTED_DIMENSION),
        Err(StrictEncodeError::NonFiniteOutput),
    );
    assert_eq!(
        validate_vector(&vec![1.0; EXPECTED_DIMENSION - 1], EXPECTED_DIMENSION),
        Err(StrictEncodeError::WrongDimensions {
            actual: EXPECTED_DIMENSION - 1,
            expected: EXPECTED_DIMENSION,
        }),
    );
}

fn model_directory() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/mcp/assets/potion/linux-x64/model")
}

fn assert_encodings_match_bit_for_bit(
    left: &[StrictEncoding],
    right: &[StrictEncoding],
) {
    assert_eq!(left.len(), right.len());
    for (left, right) in left.iter().zip(right) {
        assert_eq!(
            left.retained_token_count,
            right.retained_token_count,
            "retained-token count differs"
        );
        assert_eq!(left.vector.len(), right.vector.len());
        for (left_value, right_value) in left.vector.iter().zip(&right.vector) {
            assert_eq!(
                left_value.to_bits(),
                right_value.to_bits(),
                "vector component differs"
            );
        }
    }
}

#[test]
fn batch_pooling_matches_library_bit_for_bit_on_witness_samples() {
    let model = StrictPotionModel::load_with_both_paths(
        &model_directory(),
        DEFAULT_RETAINED_TOKEN_LIMIT,
    )
    .expect("offline Potion model");
    assert!(model.pooling_witness_passed);
    let texts = pooling_witness_texts();
    let encodings = model
        .tokenizer
        .encode_batch_fast(texts.iter().map(String::as_str).collect(), false)
        .expect("witness sample tokenization");
    assert!(encodings[3].get_ids().len() > 512);
    if let Some(unknown_token_id) = model.unknown_token_id {
        assert!(encodings[4].get_ids().contains(&unknown_token_id));
    }

    let expected = model
        .encode_batch_with_library(&texts)
        .expect("library encode_batch");
    let actual = model.encode_batch(&texts).expect("pooled encode_batch");
    assert_encodings_match_bit_for_bit(&expected, &actual);

    let single = texts
        .iter()
        .map(|text| model.encode(text).expect("pooled encode"))
        .collect::<Vec<_>>();
    assert_encodings_match_bit_for_bit(&expected, &single);
}

#[test]
fn load_keeps_only_the_witnessed_pooling_path() {
    let both = StrictPotionModel::load_with_both_paths(
        &model_directory(),
        DEFAULT_RETAINED_TOKEN_LIMIT,
    )
    .expect("offline Potion model");
    let model = StrictPotionModel::load(&model_directory(), DEFAULT_RETAINED_TOKEN_LIMIT)
        .expect("offline Potion model");
    assert!(model.pooling_witness_passed);
    assert!(model.pooling.is_some());
    assert!(model.model.is_none(), "the library copy must be released");

    let texts = pooling_witness_texts();
    let expected = both
        .encode_batch_with_library(&texts)
        .expect("library encode_batch");
    let actual = model.encode_batch(&texts).expect("pooled encode_batch");
    assert_encodings_match_bit_for_bit(&expected, &actual);
}

#[test]
fn failed_pooling_witness_selects_library_path_bit_for_bit() {
    let mut model = StrictPotionModel::load_with_both_paths(
        &model_directory(),
        DEFAULT_RETAINED_TOKEN_LIMIT,
    )
    .expect("offline Potion model");
    assert!(model.pooling_witness_passed);
    let texts = pooling_witness_texts();
    let encoding = model
        .tokenizer
        .encode(texts[0].as_str(), false)
        .expect("smoke text tokenization");
    let token_id = encoding
        .get_ids()
        .iter()
        .copied()
        .find(|id| Some(*id) != model.unknown_token_id)
        .expect("known smoke token");
    let pooling = model.pooling.as_mut().expect("copied pooling data");
    let row_index = pooling.row_index(token_id as usize);
    let columns = pooling.columns;
    pooling.embeddings[row_index * columns] += 1.0;
    model.pooling_witness_passed = model.pooling_witness_passes();
    assert!(!model.pooling_witness_passed);

    let expected = model
        .encode_batch_with_library(&texts)
        .expect("library encode_batch");
    let actual = model.encode_batch(&texts).expect("fallback encode_batch");
    assert_encodings_match_bit_for_bit(&expected, &actual);
}

fn benchmark_texts() -> Vec<String> {
    const CHUNK_CHARS: usize = 1450;
    const TOTAL_CHUNKS: usize = 20_000;
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new("git")
        .arg("-C")
        .arg(&repository)
        .args(["ls-files", "-z", "--", "*.ts", "*.c"])
        .output()
        .expect("list tracked TypeScript and C files");
    assert!(output.status.success(), "git ls-files failed");

    let mut chunks = Vec::new();
    for path in output.stdout.split(|byte| *byte == 0).filter(|path| !path.is_empty()) {
        let relative = std::str::from_utf8(path).expect("tracked path is UTF-8");
        let source = fs::read_to_string(repository.join(relative)).expect("read source file");
        let characters = source.chars().collect::<Vec<_>>();
        for start in (0..characters.len()).step_by(CHUNK_CHARS) {
            let end = (start + CHUNK_CHARS).min(characters.len());
            if end - start >= 500 {
                chunks.push(characters[start..end].iter().collect::<String>());
                if chunks.len() == TOTAL_CHUNKS {
                    return chunks;
                }
            }
        }
    }
    assert!(!chunks.is_empty(), "repository has no code chunks");
    let source_chunks = chunks.clone();
    while chunks.len() < TOTAL_CHUNKS {
        chunks.push(source_chunks[chunks.len() % source_chunks.len()].clone());
    }
    chunks.truncate(TOTAL_CHUNKS);
    chunks
}

fn run_benchmark_path(
    model: &StrictPotionModel,
    texts: &[String],
    batch_size: usize,
    use_library: bool,
) -> Duration {
    let started = Instant::now();
    for batch in texts.chunks(batch_size) {
        let output = if use_library {
            model.encode_batch_with_library(batch)
        } else {
            model.encode_batch(batch)
        }
        .expect("benchmark encoding");
        std::hint::black_box(output);
    }
    started.elapsed()
}

fn median_seconds(samples: [Duration; 3]) -> f64 {
    let mut seconds = samples.map(|sample| sample.as_secs_f64());
    seconds.sort_by(f64::total_cmp);
    seconds[1]
}

#[test]
#[ignore = "encodes 20,000 code chunks three times per path"]
fn benchmark_library_and_single_tokenization_paths() {
    const DEFAULT_BATCH_SIZE: usize = 1024;
    let model = StrictPotionModel::load_with_both_paths(
        &model_directory(),
        DEFAULT_RETAINED_TOKEN_LIMIT,
    )
    .expect("offline Potion model");
    assert!(model.pooling_witness_passed);
    let texts = benchmark_texts();
    assert_eq!(texts.len(), 20_000);
    assert!(texts
        .iter()
        .all(|text| (500..=3000).contains(&text.chars().count())));

    tokenizers::parallelism::set_parallelism(false);
    let old_single = [
        run_benchmark_path(&model, &texts, 1, true),
        run_benchmark_path(&model, &texts, 1, true),
        run_benchmark_path(&model, &texts, 1, true),
    ];
    let new_single = [
        run_benchmark_path(&model, &texts, 1, false),
        run_benchmark_path(&model, &texts, 1, false),
        run_benchmark_path(&model, &texts, 1, false),
    ];

    tokenizers::parallelism::set_parallelism(true);
    let old_batched = [
        run_benchmark_path(&model, &texts, DEFAULT_BATCH_SIZE, true),
        run_benchmark_path(&model, &texts, DEFAULT_BATCH_SIZE, true),
        run_benchmark_path(&model, &texts, DEFAULT_BATCH_SIZE, true),
    ];
    let new_batched = [
        run_benchmark_path(&model, &texts, DEFAULT_BATCH_SIZE, false),
        run_benchmark_path(&model, &texts, DEFAULT_BATCH_SIZE, false),
        run_benchmark_path(&model, &texts, DEFAULT_BATCH_SIZE, false),
    ];

    for (mode, old, new) in [
        ("single-threaded", old_single, new_single),
        ("default-batch-1024", old_batched, new_batched),
    ] {
        let old_seconds = median_seconds(old);
        let new_seconds = median_seconds(new);
        println!(
            "mode={mode} library_median_s={old_seconds:.3} library_chunks_per_s={:.1} pooled_median_s={new_seconds:.3} pooled_chunks_per_s={:.1}",
            texts.len() as f64 / old_seconds,
            texts.len() as f64 / new_seconds,
        );
    }
}
