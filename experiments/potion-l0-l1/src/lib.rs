use anyhow::{anyhow, bail, Context, Result};
use half::f16;
use model2vec_rs::model::StaticModel;
use safetensors::{tensor::Dtype, SafeTensors};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};
use tokenizers::Tokenizer;

pub const EXPECTED_DIMENSION: usize = 256;
pub const DEFAULT_RETAINED_TOKEN_LIMIT: usize = 4096;
pub const MAX_WORKER_FRAME_BYTES: usize = 1_048_576;
pub const MODEL_REVISION: &str = "e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b";
pub const MODEL2VEC_RS_REVISION: &str = "6f51c7afe2436bcb76fc467bad54eaa94f8db30d";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Query,
    Document,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrictEncoding {
    pub vector: Vec<f32>,
    pub retained_token_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StrictEncodeError {
    EmptyInput,
    AllUnknownInput,
    OversizedInput { retained: usize, limit: usize },
    ZeroNormOutput,
    NonFiniteOutput,
    WrongDimensions { actual: usize, expected: usize },
    TokenizationFailed,
    ModelEncodingFailed,
}

impl StrictEncodeError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::EmptyInput => "EMPTY_INPUT",
            Self::AllUnknownInput => "ALL_UNKNOWN_INPUT",
            Self::OversizedInput { .. } => "OVERSIZED_INPUT",
            Self::ZeroNormOutput => "ZERO_NORM_OUTPUT",
            Self::NonFiniteOutput => "NON_FINITE_OUTPUT",
            Self::WrongDimensions { .. } => "WRONG_DIMENSIONS",
            Self::TokenizationFailed => "TOKENIZATION_FAILED",
            Self::ModelEncodingFailed => "MODEL_ENCODING_FAILED",
        }
    }
}

impl std::fmt::Display for StrictEncodeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OversizedInput { retained, limit } => {
                write!(
                    formatter,
                    "{}: retained token count {retained} exceeds limit {limit}",
                    self.code()
                )
            }
            Self::WrongDimensions { actual, expected } => {
                write!(
                    formatter,
                    "{}: output has {actual} dimensions; expected {expected}",
                    self.code()
                )
            }
            _ => formatter.write_str(self.code()),
        }
    }
}

impl std::error::Error for StrictEncodeError {}

pub struct StrictPotionModel {
    model: StaticModel,
    tokenizer: Tokenizer,
    unknown_token_id: Option<u32>,
    normalize: bool,
    retained_token_limit: usize,
}

impl StrictPotionModel {
    pub fn load(model_dir: &Path, retained_token_limit: usize) -> Result<Self> {
        if retained_token_limit == 0 {
            bail!("retained token limit must be positive");
        }
        let tokenizer_bytes = fs::read(model_dir.join("tokenizer.json"))
            .context("failed to read tokenizer artifact")?;
        let strict_tokenizer_bytes = tokenizer_without_truncation_or_padding(&tokenizer_bytes)?;
        let tokenizer = Tokenizer::from_bytes(&strict_tokenizer_bytes)
            .map_err(|_| anyhow!("failed to load tokenizer artifact"))?;
        if tokenizer.get_truncation().is_some() {
            bail!("strict tokenizer still has truncation enabled");
        }
        if tokenizer.get_padding().is_some() {
            bail!("strict tokenizer still has padding enabled");
        }

        let tokenizer_spec: Value = serde_json::from_slice(&strict_tokenizer_bytes)
            .context("failed to parse strict tokenizer specification")?;
        let unknown_token = tokenizer_spec
            .get("model")
            .and_then(|model| model.get("unk_token"))
            .and_then(Value::as_str);
        let unknown_token_id = unknown_token.and_then(|token| tokenizer.token_to_id(token));

        let model_bytes = fs::read(model_dir.join("model.safetensors"))
            .context("failed to read model artifact")?;
        let config_bytes = fs::read(model_dir.join("config.json"))
            .context("failed to read model configuration")?;
        let config: Value =
            serde_json::from_slice(&config_bytes).context("failed to parse model configuration")?;
        let normalize = config
            .get("normalize")
            .and_then(Value::as_bool)
            .ok_or_else(|| anyhow!("model configuration does not declare normalize"))?;
        let model =
            StaticModel::from_bytes(&strict_tokenizer_bytes, &model_bytes, &config_bytes, None)
                .context("failed to load pinned model2vec-rs model")?;

        let tensor_file =
            SafeTensors::deserialize(&model_bytes).context("failed to inspect model dimensions")?;
        let embedding_tensor = tensor_file
            .tensor("embeddings")
            .or_else(|_| tensor_file.tensor("0"))
            .or_else(|_| tensor_file.tensor("embedding.weight"))
            .context("embedding tensor is missing")?;
        let dimensions = embedding_tensor
            .shape()
            .get(1)
            .copied()
            .ok_or_else(|| anyhow!("embedding tensor is not two dimensional"))?;
        if dimensions != EXPECTED_DIMENSION {
            return Err(StrictEncodeError::WrongDimensions {
                actual: dimensions,
                expected: EXPECTED_DIMENSION,
            }
            .into());
        }

        Ok(Self {
            model,
            tokenizer,
            unknown_token_id,
            normalize,
            retained_token_limit,
        })
    }

    pub fn normalize(&self) -> bool {
        self.normalize
    }

    pub fn retained_token_limit(&self) -> usize {
        self.retained_token_limit
    }

    pub fn retained_token_ids(
        &self,
        text: &str,
    ) -> std::result::Result<Vec<u32>, StrictEncodeError> {
        if text.trim().is_empty() {
            return Err(StrictEncodeError::EmptyInput);
        }
        let encoding = self
            .tokenizer
            .encode(text, false)
            .map_err(|_| StrictEncodeError::TokenizationFailed)?;
        let mut retained = encoding.get_ids().to_vec();
        if let Some(unknown) = self.unknown_token_id {
            retained.retain(|token_id| *token_id != unknown);
        }
        if retained.is_empty() {
            return Err(StrictEncodeError::AllUnknownInput);
        }
        if retained.len() > self.retained_token_limit {
            return Err(StrictEncodeError::OversizedInput {
                retained: retained.len(),
                limit: self.retained_token_limit,
            });
        }
        Ok(retained)
    }

    pub fn encode_query(
        &self,
        text: &str,
    ) -> std::result::Result<StrictEncoding, StrictEncodeError> {
        self.encode(text)
    }

    pub fn encode_document(
        &self,
        text: &str,
    ) -> std::result::Result<StrictEncoding, StrictEncodeError> {
        self.encode(text)
    }

    pub fn encode(&self, text: &str) -> std::result::Result<StrictEncoding, StrictEncodeError> {
        let retained_ids = self.retained_token_ids(text)?;
        let vectors = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.model.encode_with_args(&[text.to_owned()], None, 1)
        }))
        .map_err(|_| StrictEncodeError::ModelEncodingFailed)?;
        let vector = vectors
            .into_iter()
            .next()
            .ok_or(StrictEncodeError::ModelEncodingFailed)?;
        validate_vector(&vector, EXPECTED_DIMENSION)?;
        Ok(StrictEncoding {
            vector,
            retained_token_count: retained_ids.len(),
        })
    }

    pub fn encode_batch(
        &self,
        texts: &[String],
    ) -> std::result::Result<Vec<StrictEncoding>, StrictEncodeError> {
        let retained_counts = texts
            .iter()
            .map(|text| self.retained_token_ids(text).map(|tokens| tokens.len()))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let vectors = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.model.encode_with_args(texts, None, texts.len().max(1))
        }))
        .map_err(|_| StrictEncodeError::ModelEncodingFailed)?;
        if vectors.len() != texts.len() {
            return Err(StrictEncodeError::ModelEncodingFailed);
        }
        vectors
            .into_iter()
            .zip(retained_counts)
            .map(|(vector, retained_token_count)| {
                validate_vector(&vector, EXPECTED_DIMENSION)?;
                Ok(StrictEncoding {
                    vector,
                    retained_token_count,
                })
            })
            .collect()
    }
}

pub fn validate_vector(
    vector: &[f32],
    expected_dimension: usize,
) -> std::result::Result<(), StrictEncodeError> {
    if vector.len() != expected_dimension {
        return Err(StrictEncodeError::WrongDimensions {
            actual: vector.len(),
            expected: expected_dimension,
        });
    }
    if vector.iter().any(|value| !value.is_finite()) {
        return Err(StrictEncodeError::NonFiniteOutput);
    }
    let squared_norm = vector.iter().map(|value| value * value).sum::<f32>();
    if !squared_norm.is_finite() {
        return Err(StrictEncodeError::NonFiniteOutput);
    }
    if squared_norm <= f32::EPSILON {
        return Err(StrictEncodeError::ZeroNormOutput);
    }
    Ok(())
}

fn tokenizer_without_truncation_or_padding(tokenizer_bytes: &[u8]) -> Result<Vec<u8>> {
    let mut specification: Value =
        serde_json::from_slice(tokenizer_bytes).context("failed to parse tokenizer artifact")?;
    let object = specification
        .as_object_mut()
        .ok_or_else(|| anyhow!("tokenizer artifact is not a JSON object"))?;
    object.insert("truncation".to_owned(), Value::Null);
    object.insert("padding".to_owned(), Value::Null);
    serde_json::to_vec(&specification).context("failed to serialize strict tokenizer")
}

pub struct RawReferenceModel {
    embeddings: Vec<f32>,
    rows: usize,
    columns: usize,
    weights: Option<Vec<f32>>,
    mapping: Option<Vec<usize>>,
    normalize: bool,
}

impl RawReferenceModel {
    pub fn load(model_dir: &Path) -> Result<Self> {
        let model_bytes = fs::read(model_dir.join("model.safetensors"))
            .context("failed to read reference model artifact")?;
        let tensors = SafeTensors::deserialize(&model_bytes)
            .context("failed to parse reference model artifact")?;
        let embedding = tensors
            .tensor("embeddings")
            .or_else(|_| tensors.tensor("0"))
            .or_else(|_| tensors.tensor("embedding.weight"))
            .context("reference embedding tensor is missing")?;
        let [rows, columns]: [usize; 2] = embedding
            .shape()
            .try_into()
            .map_err(|_| anyhow!("reference embedding tensor is not two dimensional"))?;
        let embeddings = decode_float_tensor(embedding.dtype(), embedding.data())?;
        if embeddings.len() != rows * columns {
            bail!("reference embedding tensor length is inconsistent");
        }
        let weights = tensors
            .tensor("weights")
            .ok()
            .map(|tensor| decode_float_tensor(tensor.dtype(), tensor.data()))
            .transpose()?;
        let mapping = tensors
            .tensor("mapping")
            .ok()
            .map(|tensor| decode_mapping(tensor.dtype(), tensor.data()))
            .transpose()?;
        let config: Value = serde_json::from_slice(
            &fs::read(model_dir.join("config.json")).context("failed to read reference config")?,
        )
        .context("failed to parse reference config")?;
        let normalize = config
            .get("normalize")
            .and_then(Value::as_bool)
            .ok_or_else(|| anyhow!("reference config does not declare normalize"))?;
        Ok(Self {
            embeddings,
            rows,
            columns,
            weights,
            mapping,
            normalize,
        })
    }

    pub fn pool(&self, original_token_ids: &[u32]) -> Result<Vec<f32>> {
        if original_token_ids.is_empty() {
            bail!("reference pooling requires at least one retained token");
        }
        let mut sum = vec![0.0_f32; self.columns];
        for original_id in original_token_ids {
            let token_id = *original_id as usize;
            let row_index = self
                .mapping
                .as_ref()
                .and_then(|mapping| mapping.get(token_id))
                .copied()
                .unwrap_or(token_id);
            if row_index >= self.rows {
                bail!("reference mapping points outside the embedding table");
            }
            let weight = self
                .weights
                .as_ref()
                .and_then(|weights| weights.get(token_id))
                .copied()
                .unwrap_or(1.0);
            let row_start = row_index * self.columns;
            for (output, component) in sum
                .iter_mut()
                .zip(&self.embeddings[row_start..row_start + self.columns])
            {
                *output += component * weight;
            }
        }
        let retained_count = original_token_ids.len() as f32;
        for component in &mut sum {
            *component /= retained_count;
        }
        if self.normalize {
            let norm = sum
                .iter()
                .map(|component| component * component)
                .sum::<f32>()
                .sqrt();
            if !norm.is_finite() || norm <= f32::EPSILON {
                bail!("reference output has invalid norm");
            }
            for component in &mut sum {
                *component /= norm;
            }
        }
        validate_vector(&sum, EXPECTED_DIMENSION)?;
        Ok(sum)
    }
}

fn decode_float_tensor(dtype: Dtype, bytes: &[u8]) -> Result<Vec<f32>> {
    match dtype {
        Dtype::F64 => Ok(bytes
            .chunks_exact(8)
            .map(|chunk| f64::from_le_bytes(chunk.try_into().expect("fixed f64 width")) as f32)
            .collect()),
        Dtype::F32 => Ok(bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes(chunk.try_into().expect("fixed f32 width")))
            .collect()),
        Dtype::F16 => Ok(bytes
            .chunks_exact(2)
            .map(|chunk| f16::from_le_bytes(chunk.try_into().expect("fixed f16 width")).to_f32())
            .collect()),
        Dtype::I8 => Ok(bytes.iter().map(|byte| f32::from(*byte as i8)).collect()),
        other => bail!("unsupported reference float tensor dtype: {other:?}"),
    }
}

fn decode_mapping(dtype: Dtype, bytes: &[u8]) -> Result<Vec<usize>> {
    match dtype {
        Dtype::I64 => bytes
            .chunks_exact(8)
            .map(|chunk| {
                let value = i64::from_le_bytes(chunk.try_into().expect("fixed i64 width"));
                usize::try_from(value).context("negative reference mapping entry")
            })
            .collect(),
        Dtype::I32 => bytes
            .chunks_exact(4)
            .map(|chunk| {
                let value = i32::from_le_bytes(chunk.try_into().expect("fixed i32 width"));
                usize::try_from(value).context("negative reference mapping entry")
            })
            .collect(),
        other => bail!("unsupported reference mapping dtype: {other:?}"),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureInputs {
    pub schema_version: u32,
    pub model_revision: String,
    pub model2vec_rs_revision: String,
    pub tolerance: NumericalTolerance,
    pub cases: Vec<FixtureInputCase>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NumericalTolerance {
    pub max_absolute_difference: f32,
    pub minimum_cosine_similarity: f32,
}

#[derive(Debug, Deserialize)]
pub struct FixtureInputCase {
    pub id: String,
    pub role: Role,
    pub text: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenFixtures {
    pub schema_version: u32,
    pub model_revision: String,
    pub model2vec_rs_revision: String,
    pub tokenizer_override: String,
    pub retained_token_limit: usize,
    pub query_treatment: String,
    pub document_treatment: String,
    pub pooling: String,
    pub normalization: bool,
    pub tolerance: NumericalTolerance,
    pub cases: Vec<FrozenFixtureCase>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenFixtureCase {
    pub id: String,
    pub role: Role,
    pub text: String,
    pub retained_token_count: usize,
    pub vector: Vec<f32>,
    pub vector_f32le_sha256: String,
}

pub fn freeze_fixtures(
    model: &StrictPotionModel,
    input_path: &Path,
    output_path: &Path,
) -> Result<()> {
    let inputs: FixtureInputs =
        serde_json::from_slice(&fs::read(input_path).context("failed to read fixture inputs")?)
            .context("failed to parse fixture inputs")?;
    if inputs.model_revision != MODEL_REVISION
        || inputs.model2vec_rs_revision != MODEL2VEC_RS_REVISION
    {
        bail!("fixture input authority does not match the compiled contract");
    }
    let cases = inputs
        .cases
        .into_iter()
        .map(|case| {
            let encoded = match case.role {
                Role::Query => model.encode_query(&case.text),
                Role::Document => model.encode_document(&case.text),
            }?;
            Ok(FrozenFixtureCase {
                id: case.id,
                role: case.role,
                text: case.text,
                retained_token_count: encoded.retained_token_count,
                vector_f32le_sha256: vector_sha256(&encoded.vector),
                vector: encoded.vector,
            })
        })
        .collect::<std::result::Result<Vec<_>, StrictEncodeError>>()?;
    let frozen = FrozenFixtures {
        schema_version: inputs.schema_version,
        model_revision: inputs.model_revision,
        model2vec_rs_revision: inputs.model2vec_rs_revision,
        tokenizer_override: "serialized truncation=null; padding=null".to_owned(),
        retained_token_limit: model.retained_token_limit(),
        query_treatment: "symmetric; exact input; no prefix".to_owned(),
        document_treatment: "symmetric; exact input; no prefix".to_owned(),
        pooling: "unknown removal -> original-ID mapping -> original-ID weight -> sum -> retained-count denominator".to_owned(),
        normalization: model.normalize(),
        tolerance: inputs.tolerance,
        cases,
    };
    let mut bytes =
        serde_json::to_vec_pretty(&frozen).context("failed to serialize frozen fixtures")?;
    bytes.push(b'\n');
    fs::write(output_path, bytes).context("failed to write frozen fixtures")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConformanceReport {
    pub schema_version: u32,
    pub passed: bool,
    pub model_revision: String,
    pub model2vec_rs_revision: String,
    pub retained_token_limit: usize,
    pub dimensions: usize,
    pub normalize: bool,
    pub fixture_count: usize,
    pub maximum_fixture_absolute_difference: f32,
    pub minimum_fixture_cosine_similarity: f32,
    pub maximum_raw_reference_absolute_difference: f32,
    pub minimum_raw_reference_cosine_similarity: f32,
    pub accepted_retained_tokens_above_512: usize,
    pub symmetric_query_document_max_difference: f32,
    pub error_behavior: Vec<ErrorBehavior>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBehavior {
    pub case: String,
    pub observed_code: String,
    pub passed: bool,
}

pub fn verify_conformance(model_dir: &Path, fixtures_path: &Path) -> Result<ConformanceReport> {
    let fixtures: FrozenFixtures =
        serde_json::from_slice(&fs::read(fixtures_path).context("failed to read frozen fixtures")?)
            .context("failed to parse frozen fixtures")?;
    if fixtures.model_revision != MODEL_REVISION
        || fixtures.model2vec_rs_revision != MODEL2VEC_RS_REVISION
    {
        bail!("frozen fixture authority does not match the compiled contract");
    }
    if fixtures.retained_token_limit != DEFAULT_RETAINED_TOKEN_LIMIT {
        bail!("frozen fixture retained-token limit is not the selected contract limit");
    }
    let model = StrictPotionModel::load(model_dir, fixtures.retained_token_limit)?;
    let reference = RawReferenceModel::load(model_dir)?;

    let mut maximum_fixture_absolute_difference = 0.0_f32;
    let mut minimum_fixture_cosine_similarity = 1.0_f32;
    let mut maximum_raw_reference_absolute_difference = 0.0_f32;
    let mut minimum_raw_reference_cosine_similarity = 1.0_f32;
    for fixture in &fixtures.cases {
        let encoded = match fixture.role {
            Role::Query => model.encode_query(&fixture.text),
            Role::Document => model.encode_document(&fixture.text),
        }?;
        if encoded.retained_token_count != fixture.retained_token_count {
            bail!("fixture retained-token count changed for {}", fixture.id);
        }
        if vector_sha256(&encoded.vector) != fixture.vector_f32le_sha256 {
            let (difference, cosine) = compare_vectors(&encoded.vector, &fixture.vector)?;
            if difference > fixtures.tolerance.max_absolute_difference
                || cosine < fixtures.tolerance.minimum_cosine_similarity
            {
                bail!("fixture numerical tolerance failed for {}", fixture.id);
            }
        }
        let (fixture_difference, fixture_cosine) =
            compare_vectors(&encoded.vector, &fixture.vector)?;
        maximum_fixture_absolute_difference =
            maximum_fixture_absolute_difference.max(fixture_difference);
        minimum_fixture_cosine_similarity = minimum_fixture_cosine_similarity.min(fixture_cosine);

        let retained_ids = model.retained_token_ids(&fixture.text)?;
        let raw = reference.pool(&retained_ids)?;
        let (raw_difference, raw_cosine) = compare_vectors(&encoded.vector, &raw)?;
        maximum_raw_reference_absolute_difference =
            maximum_raw_reference_absolute_difference.max(raw_difference);
        minimum_raw_reference_cosine_similarity =
            minimum_raw_reference_cosine_similarity.min(raw_cosine);
        if raw_difference > fixtures.tolerance.max_absolute_difference
            || raw_cosine < fixtures.tolerance.minimum_cosine_similarity
        {
            bail!("raw pooling conformance failed for {}", fixture.id);
        }
    }

    let long_input = "a ".repeat(513);
    let long_encoding = model.encode_document(&long_input)?;
    if long_encoding.retained_token_count <= 512 {
        bail!("non-truncating witness did not retain more than 512 tokens");
    }

    let symmetric_text = &fixtures
        .cases
        .first()
        .ok_or_else(|| anyhow!("frozen fixture set is empty"))?
        .text;
    let query = model.encode_query(symmetric_text)?;
    let document = model.encode_document(symmetric_text)?;
    let (symmetric_difference, _) = compare_vectors(&query.vector, &document.vector)?;
    if symmetric_difference != 0.0 {
        bail!("query and document treatment are not symmetric");
    }

    let error_behavior = vec![
        observe_error(
            "empty_input",
            model.encode(""),
            StrictEncodeError::EmptyInput,
        ),
        observe_error(
            "all_unknown_input",
            model.encode("\u{10ffff}"),
            StrictEncodeError::AllUnknownInput,
        ),
        observe_error(
            "oversized_input",
            model.encode(&"a ".repeat(DEFAULT_RETAINED_TOKEN_LIMIT + 1)),
            StrictEncodeError::OversizedInput {
                retained: DEFAULT_RETAINED_TOKEN_LIMIT + 1,
                limit: DEFAULT_RETAINED_TOKEN_LIMIT,
            },
        ),
        observe_validation_error(
            "zero_norm_output",
            validate_vector(&vec![0.0; EXPECTED_DIMENSION], EXPECTED_DIMENSION),
            StrictEncodeError::ZeroNormOutput,
        ),
        observe_validation_error(
            "non_finite_output",
            validate_vector(&vec![f32::NAN; EXPECTED_DIMENSION], EXPECTED_DIMENSION),
            StrictEncodeError::NonFiniteOutput,
        ),
        observe_validation_error(
            "wrong_dimensions",
            validate_vector(&vec![1.0; EXPECTED_DIMENSION - 1], EXPECTED_DIMENSION),
            StrictEncodeError::WrongDimensions {
                actual: EXPECTED_DIMENSION - 1,
                expected: EXPECTED_DIMENSION,
            },
        ),
    ];
    if error_behavior.iter().any(|behavior| !behavior.passed) {
        bail!("one or more invalid-input/output contracts failed");
    }

    Ok(ConformanceReport {
        schema_version: 1,
        passed: true,
        model_revision: MODEL_REVISION.to_owned(),
        model2vec_rs_revision: MODEL2VEC_RS_REVISION.to_owned(),
        retained_token_limit: DEFAULT_RETAINED_TOKEN_LIMIT,
        dimensions: EXPECTED_DIMENSION,
        normalize: model.normalize(),
        fixture_count: fixtures.cases.len(),
        maximum_fixture_absolute_difference,
        minimum_fixture_cosine_similarity,
        maximum_raw_reference_absolute_difference,
        minimum_raw_reference_cosine_similarity,
        accepted_retained_tokens_above_512: long_encoding.retained_token_count,
        symmetric_query_document_max_difference: symmetric_difference,
        error_behavior,
    })
}

fn observe_error(
    case: &str,
    result: std::result::Result<StrictEncoding, StrictEncodeError>,
    expected: StrictEncodeError,
) -> ErrorBehavior {
    let observed = result.err();
    ErrorBehavior {
        case: case.to_owned(),
        observed_code: observed
            .as_ref()
            .map(|error| error.code().to_owned())
            .unwrap_or_else(|| "NO_ERROR".to_owned()),
        passed: observed.as_ref().map(StrictEncodeError::code) == Some(expected.code()),
    }
}

fn observe_validation_error(
    case: &str,
    result: std::result::Result<(), StrictEncodeError>,
    expected: StrictEncodeError,
) -> ErrorBehavior {
    let observed = result.err();
    ErrorBehavior {
        case: case.to_owned(),
        observed_code: observed
            .as_ref()
            .map(|error| error.code().to_owned())
            .unwrap_or_else(|| "NO_ERROR".to_owned()),
        passed: observed.as_ref().map(StrictEncodeError::code) == Some(expected.code()),
    }
}

pub fn vector_sha256(vector: &[f32]) -> String {
    let mut hasher = Sha256::new();
    for component in vector {
        hasher.update(component.to_le_bytes());
    }
    format!("{:x}", hasher.finalize())
}

pub fn compare_vectors(left: &[f32], right: &[f32]) -> Result<(f32, f32)> {
    if left.len() != right.len() {
        bail!("cannot compare vectors with different dimensions");
    }
    let mut maximum_absolute_difference = 0.0_f32;
    let mut dot = 0.0_f32;
    let mut left_norm = 0.0_f32;
    let mut right_norm = 0.0_f32;
    for (left_component, right_component) in left.iter().zip(right) {
        maximum_absolute_difference =
            maximum_absolute_difference.max((left_component - right_component).abs());
        dot += left_component * right_component;
        left_norm += left_component * left_component;
        right_norm += right_component * right_component;
    }
    let denominator = left_norm.sqrt() * right_norm.sqrt();
    if denominator <= f32::EPSILON || !denominator.is_finite() {
        bail!("cannot compare zero-norm or non-finite vectors");
    }
    Ok((maximum_absolute_difference, dot / denominator))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkReport {
    pub schema_version: u32,
    pub model_load_ms: f64,
    pub rss_before_load_bytes: u64,
    pub rss_after_load_bytes: u64,
    pub model_related_rss_bytes: u64,
    pub batch_size: usize,
    pub batch_warmups: usize,
    pub batch_samples: usize,
    pub batch_items_per_second: f64,
    pub latency_warmups: usize,
    pub latency_samples: usize,
    pub warm_latency_p50_ms: f64,
    pub warm_latency_p95_ms: f64,
    pub deterministic_repetitions: usize,
    pub deterministic_max_absolute_variance: f32,
    pub timing_clock: String,
    pub percentile_method: String,
    pub operation_order: Vec<String>,
}

pub fn benchmark(model_dir: &Path, fixtures_path: &Path) -> Result<BenchmarkReport> {
    const BATCH_SIZE: usize = 64;
    const BATCH_WARMUPS: usize = 5;
    const BATCH_SAMPLES: usize = 100;
    const LATENCY_WARMUPS: usize = 20;
    const LATENCY_SAMPLES: usize = 500;
    const DETERMINISTIC_REPETITIONS: usize = 50;

    let fixtures: FrozenFixtures = serde_json::from_slice(
        &fs::read(fixtures_path).context("failed to read benchmark fixtures")?,
    )
    .context("failed to parse benchmark fixtures")?;
    let rss_before_load_bytes = resident_set_bytes()?;
    let load_started = Instant::now();
    let model = StrictPotionModel::load(model_dir, DEFAULT_RETAINED_TOKEN_LIMIT)?;
    let model_load_ms = duration_ms(load_started.elapsed());
    let rss_after_load_bytes = resident_set_bytes()?;

    let seed_texts: Vec<String> = fixtures
        .cases
        .iter()
        .map(|case| case.text.clone())
        .collect();
    if seed_texts.is_empty() {
        bail!("benchmark fixture set is empty");
    }
    let batch: Vec<String> = (0..BATCH_SIZE)
        .map(|index| seed_texts[index % seed_texts.len()].clone())
        .collect();
    for _ in 0..BATCH_WARMUPS {
        model.encode_batch(&batch)?;
    }
    let batch_started = Instant::now();
    for _ in 0..BATCH_SAMPLES {
        model.encode_batch(&batch)?;
    }
    let batch_elapsed = batch_started.elapsed();
    let batch_items_per_second = (BATCH_SIZE * BATCH_SAMPLES) as f64 / batch_elapsed.as_secs_f64();

    let latency_text = &seed_texts[0];
    for _ in 0..LATENCY_WARMUPS {
        model.encode_query(latency_text)?;
    }
    let mut latencies = Vec::with_capacity(LATENCY_SAMPLES);
    for _ in 0..LATENCY_SAMPLES {
        let started = Instant::now();
        model.encode_query(latency_text)?;
        latencies.push(started.elapsed());
    }

    let baseline = model.encode_query(latency_text)?.vector;
    let mut deterministic_max_absolute_variance = 0.0_f32;
    for _ in 0..DETERMINISTIC_REPETITIONS {
        let repeated = model.encode_query(latency_text)?.vector;
        let (difference, _) = compare_vectors(&baseline, &repeated)?;
        deterministic_max_absolute_variance = deterministic_max_absolute_variance.max(difference);
    }

    Ok(BenchmarkReport {
        schema_version: 1,
        model_load_ms,
        rss_before_load_bytes,
        rss_after_load_bytes,
        model_related_rss_bytes: rss_after_load_bytes.saturating_sub(rss_before_load_bytes),
        batch_size: BATCH_SIZE,
        batch_warmups: BATCH_WARMUPS,
        batch_samples: BATCH_SAMPLES,
        batch_items_per_second,
        latency_warmups: LATENCY_WARMUPS,
        latency_samples: LATENCY_SAMPLES,
        warm_latency_p50_ms: duration_ms(nearest_rank(&mut latencies.clone(), 0.50)),
        warm_latency_p95_ms: duration_ms(nearest_rank(&mut latencies, 0.95)),
        deterministic_repetitions: DETERMINISTIC_REPETITIONS,
        deterministic_max_absolute_variance,
        timing_clock: "std::time::Instant monotonic clock".to_owned(),
        percentile_method: "nearest rank: sorted[ceil(p*n)-1]".to_owned(),
        operation_order: vec![
            "cold process/model load with uncontrolled OS page cache".to_owned(),
            "RSS readback".to_owned(),
            "batch warmups".to_owned(),
            "batch samples".to_owned(),
            "single-item warmups".to_owned(),
            "single-item latency samples".to_owned(),
            "determinism repetitions".to_owned(),
        ],
    })
}

fn resident_set_bytes() -> Result<u64> {
    let status =
        fs::read_to_string("/proc/self/status").context("failed to read process status")?;
    let line = status
        .lines()
        .find(|line| line.starts_with("VmRSS:"))
        .ok_or_else(|| anyhow!("process status does not contain VmRSS"))?;
    let kilobytes = line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| anyhow!("VmRSS is malformed"))?
        .parse::<u64>()
        .context("VmRSS is not numeric")?;
    Ok(kilobytes * 1024)
}

fn duration_ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn nearest_rank(values: &mut [Duration], percentile: f64) -> Duration {
    values.sort_unstable();
    let index = ((percentile * values.len() as f64).ceil() as usize)
        .saturating_sub(1)
        .min(values.len().saturating_sub(1));
    values[index]
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
