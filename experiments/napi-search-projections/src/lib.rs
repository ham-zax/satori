use napi::{bindgen_prelude::*, Task};
use napi_derive::napi;
use std::{
    collections::HashSet,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

const MAX_INPUTS: usize = 64;
const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_OUTPUT: usize = 16 * 1024 * 1024;

#[napi(object)]
pub struct ProjectionInput {
    pub content: String,
    pub relative_path: String,
    pub language: Option<String>,
    pub symbol_kind: Option<String>,
    pub symbol_label: Option<String>,
    pub breadcrumbs: Option<Vec<String>>,
}
impl ProjectionInput {
    fn strings(&self) -> impl Iterator<Item = &str> {
        [self.content.as_str(), self.relative_path.as_str()]
            .into_iter()
            .chain(self.language.as_deref())
            .chain(self.symbol_kind.as_deref())
            .chain(self.symbol_label.as_deref())
            .chain(self.breadcrumbs.iter().flatten().map(String::as_str))
    }
}
#[napi(object)]
pub struct SearchProjections {
    pub embedding_text: String,
    pub lexical_text: String,
    pub embedding_version: String,
    pub lexical_version: String,
}
#[napi]
#[derive(Default)]
pub struct ProjectionCancellation {
    flag: Arc<AtomicBool>,
}
#[napi]
impl ProjectionCancellation {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }
    #[napi]
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Release);
    }
}
fn cancelled(flag: &AtomicBool) -> Result<()> {
    if flag.load(Ordering::Acquire) {
        Err(Error::from_reason("Projection computation cancelled"))
    } else {
        Ok(())
    }
}
fn identifier(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}
// These boundaries are exactly the two reference replacements on ASCII tokens.
fn components(token: &str) -> Vec<&str> {
    let bytes = token.as_bytes();
    let mut result = Vec::new();
    let mut start = 0;
    for i in 0..bytes.len() {
        let separator = bytes[i] == b'_' || bytes[i] == b'$';
        let boundary = i > 0
            && ((bytes[i - 1].is_ascii_lowercase() || bytes[i - 1].is_ascii_digit())
                && bytes[i].is_ascii_uppercase()
                || bytes[i - 1].is_ascii_uppercase()
                    && bytes[i].is_ascii_uppercase()
                    && bytes.get(i + 1).is_some_and(u8::is_ascii_lowercase));
        if separator || boundary {
            if start < i {
                result.push(&token[start..i]);
            }
            start = if separator { i + 1 } else { i };
        }
    }
    if start < bytes.len() {
        result.push(&token[start..]);
    }
    result
}
fn tokens<'a>(
    value: &'a str,
    flag: &AtomicBool,
    mut visit: impl FnMut(&'a str) -> bool,
) -> Result<bool> {
    let mut start = 0;
    for (i, byte) in value.bytes().enumerate() {
        if i % 256 == 0 {
            cancelled(flag)?;
        }
        if !identifier(byte) {
            if start < i && (i - start > 256 || !visit(&value[start..i])) {
                return Ok(false);
            }
            start = i + 1;
        } else if i - start >= 256 {
            return Ok(false);
        }
    }
    Ok(start == value.len() || visit(&value[start..]))
}
struct Budget {
    left: usize,
}
impl Budget {
    fn take(&mut self, bytes: usize) -> bool {
        if bytes > self.left {
            false
        } else {
            self.left -= bytes;
            true
        }
    }
}
#[derive(Default)]
struct Ordered {
    seen: HashSet<String>,
    values: Vec<String>,
}
impl Ordered {
    fn add(&mut self, value: &str, budget: &mut Budget) -> bool {
        if self.seen.contains(value) {
            return true;
        }
        // Charge escaped JSON plus duplicate set/vector storage before allocation.
        if !budget.take(value.len() * 12 + 32) {
            return false;
        }
        self.seen.insert(value.to_owned());
        self.values.push(value.to_owned());
        true
    }
}
fn additive(
    values: &[&str],
    flag: &AtomicBool,
    budget: &mut Budget,
) -> Result<Option<Vec<String>>> {
    let mut terms = Ordered::default();
    for value in values {
        if !tokens(value, flag, |token| {
            components(token)
                .into_iter()
                .all(|part| part == token || terms.add(part, budget))
        })? {
            return Ok(None);
        }
    }
    Ok(Some(terms.values))
}
fn quoted(value: &str) -> String {
    serde_json::to_string(value).expect("string serialization")
}
fn project(
    input: &ProjectionInput,
    flag: &AtomicBool,
    budget: &mut Budget,
) -> Result<Option<SearchProjections>> {
    if input.breadcrumbs.as_ref().is_some_and(|v| v.len() > 256) {
        return Ok(None);
    }
    let strings: Vec<&str> = input.strings().collect();
    if strings.iter().any(|value| !value.is_ascii()) {
        return Ok(None);
    }
    // Covers content twice, every metadata occurrence and JSON escaping, and framing.
    if !budget.take(
        input.content.len() * 2
            + strings.iter().skip(1).map(|v| v.len() * 18).sum::<usize>()
            + input.breadcrumbs.as_ref().map_or(0, |v| v.len() * 12)
            + 1024,
    ) {
        return Ok(None);
    }
    let mut metadata_values = vec![input.relative_path.as_str()];
    metadata_values.extend(input.language.as_deref().filter(|v| !v.is_empty()));
    metadata_values.extend(input.symbol_kind.as_deref().filter(|v| !v.is_empty()));
    metadata_values.extend(input.symbol_label.as_deref().filter(|v| !v.is_empty()));
    metadata_values.extend(
        input
            .breadcrumbs
            .iter()
            .flatten()
            .map(String::as_str)
            .filter(|v| !v.is_empty()),
    );
    metadata_values.push(&input.content);
    let Some(terms) = additive(&metadata_values, flag, budget)? else {
        return Ok(None);
    };
    let mut identity = vec![input.symbol_label.as_deref().unwrap_or("")];
    identity.extend(input.breadcrumbs.iter().flatten().map(String::as_str));
    let Some(semantic_terms) = additive(&identity, flag, budget)? else {
        return Ok(None);
    };
    let mut aliases = Ordered::default();
    for (value, source) in identity
        .iter()
        .map(|v| (*v, false))
        .chain(std::iter::once((input.content.as_str(), true)))
    {
        let mut cancellation_seen = false;
        let ok = tokens(value, flag, |token| {
            let parts = components(token);
            if source && parts.len() <= 1 {
                return true;
            }
            if parts.len() > 1 {
                // Assemble on the stack. Charge before allocating a new alias string.
                let mut joined = [0u8; 256];
                let mut length = 0;
                for part in &parts {
                    joined[length..length + part.len()].copy_from_slice(part.as_bytes());
                    length += part.len();
                }
                let joined = std::str::from_utf8(&joined[..length]).expect("ASCII components");
                if !aliases.add(joined, budget) {
                    return false;
                }
            }
            for part in parts {
                for length in 4..part.len() {
                    if flag.load(Ordering::Acquire) {
                        cancellation_seen = true;
                        return false;
                    }
                    if !aliases.add(&part[..length], budget) {
                        return false;
                    }
                }
            }
            true
        })?;
        if cancellation_seen {
            cancelled(flag)?;
        }
        if !ok {
            return Ok(None);
        }
    }
    let mut metadata = serde_json::Map::new();
    metadata.insert("path".into(), input.relative_path.clone().into());
    let mut semantic = vec![format!("path:{}", quoted(&input.relative_path))];
    for (key, label, value) in [
        ("language", "language", &input.language),
        ("symbolKind", "symbol-kind", &input.symbol_kind),
        ("symbolLabel", "symbol", &input.symbol_label),
    ] {
        if let Some(value) = value.as_ref().filter(|v| !v.is_empty()) {
            metadata.insert(key.into(), value.clone().into());
            semantic.push(format!("{label}:{}", quoted(value)));
        }
    }
    if !semantic_terms.is_empty() {
        semantic.push(format!(
            "symbol-terms:{}",
            quoted(&semantic_terms.join(" "))
        ));
    }
    if let Some(crumbs) = input.breadcrumbs.as_ref().filter(|v| !v.is_empty()) {
        metadata.insert(
            "breadcrumbs".into(),
            serde_json::to_value(crumbs).map_err(|e| Error::from_reason(e.to_string()))?,
        );
        semantic.push(format!(
            "breadcrumbs:{}",
            serde_json::to_string(crumbs).map_err(|e| Error::from_reason(e.to_string()))?
        ));
    }
    let content = format!("content:{}\n{}", input.content.len(), input.content);
    Ok(Some(SearchProjections {
        embedding_text: format!("search-identity:\n{}\n{content}", semantic.join("\n")),
        lexical_text: format!(
            "{content}\nmetadata:{}\nidentifier-components:{}\nidentifier-aliases:{}",
            serde_json::Value::Object(metadata),
            serde_json::to_string(&terms).map_err(|e| Error::from_reason(e.to_string()))?,
            serde_json::to_string(&aliases.values)
                .map_err(|e| Error::from_reason(e.to_string()))?
        ),
        embedding_version: "embedding_projection_v3".into(),
        lexical_version: "lexical_projection_v2".into(),
    }))
}

pub struct ProjectionTask {
    inputs: Vec<ProjectionInput>,
    flag: Arc<AtomicBool>,
    output_limit: usize,
    #[cfg(feature = "test-faults")]
    faults: faults::Faults,
}
impl Task for ProjectionTask {
    type Output = Vec<Option<SearchProjections>>;
    type JsValue = Vec<Option<SearchProjections>>;
    fn compute(&mut self) -> Result<Self::Output> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            #[cfg(feature = "test-faults")]
            self.faults.wait();
            let mut output = Vec::with_capacity(self.inputs.len());
            let mut remaining = self.output_limit;
            for (index, input) in self.inputs.iter().enumerate() {
                cancelled(&self.flag)?;
                #[cfg(feature = "test-faults")]
                self.faults.at(index)?;
                #[cfg(not(feature = "test-faults"))]
                let _ = index;
                let mut budget = Budget { left: remaining };
                let item = project(input, &self.flag, &mut budget)?;
                if item.is_some() {
                    remaining = budget.left;
                }
                output.push(item);
            }
            cancelled(&self.flag)?;
            Ok(output)
        }))
        .unwrap_or_else(|_| Err(Error::from_reason("Projection task panic contained")));
        #[cfg(feature = "test-faults")]
        self.faults.finish(self.flag.load(Ordering::Acquire));
        result
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}
fn task(
    inputs: Vec<ProjectionInput>,
    token: Option<&ProjectionCancellation>,
) -> Result<ProjectionTask> {
    if inputs.len() > MAX_INPUTS
        || inputs
            .iter()
            .flat_map(ProjectionInput::strings)
            .try_fold(0usize, |sum, v| sum.checked_add(v.len()))
            .is_none_or(|n| n > MAX_BYTES)
    {
        return Err(Error::from_reason(
            "Projection batch exceeds 64 inputs or 4 MiB",
        ));
    }
    Ok(ProjectionTask {
        inputs,
        flag: token.map(|t| t.flag.clone()).unwrap_or_default(),
        output_limit: MAX_OUTPUT,
        #[cfg(feature = "test-faults")]
        faults: faults::Faults::default(),
    })
}
#[napi]
pub fn build_projection_batch(
    inputs: Vec<ProjectionInput>,
    token: Option<&ProjectionCancellation>,
) -> Result<AsyncTask<ProjectionTask>> {
    Ok(AsyncTask::new(task(inputs, token)?))
}

#[cfg(feature = "test-faults")]
pub mod faults;
