use anyhow::{anyhow, bail, Context, Result};
use satori_potion_l0_l1::{
    benchmark, freeze_fixtures, verify_conformance, Role, StrictPotionModel,
    DEFAULT_RETAINED_TOKEN_LIMIT, MAX_WORKER_FRAME_BYTES,
};
use serde::{Deserialize, Serialize};
use std::env;
use std::io::{self, BufRead, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    match arguments.first().map(String::as_str) {
        Some("freeze-fixtures") => {
            require_argument_count(&arguments, 4)?;
            let model = StrictPotionModel::load(Path::new(&arguments[1]), DEFAULT_RETAINED_TOKEN_LIMIT)?;
            freeze_fixtures(&model, Path::new(&arguments[2]), Path::new(&arguments[3]))
        }
        Some("conformance") => {
            require_argument_count(&arguments, 3)?;
            let report = verify_conformance(Path::new(&arguments[1]), Path::new(&arguments[2]))?;
            write_json(&report)
        }
        Some("benchmark") => {
            require_argument_count(&arguments, 3)?;
            let report = benchmark(Path::new(&arguments[1]), Path::new(&arguments[2]))?;
            write_json(&report)
        }
        Some("worker") => {
            if !(arguments.len() == 2 || arguments.len() == 3) {
                bail!("usage: worker MODEL_DIR [--block-network]");
            }
            let block_network = arguments.get(2).map(String::as_str) == Some("--block-network");
            run_worker(PathBuf::from(&arguments[1]), block_network)
        }
        Some("network-probe") => {
            require_argument_count(&arguments, 1)?;
            let address: SocketAddr = "198.51.100.1:9".parse().expect("static socket address");
            match TcpStream::connect_timeout(&address, Duration::from_millis(100)) {
                Ok(_) => bail!("network probe unexpectedly connected"),
                Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                    write_json(&serde_json::json!({
                        "blocked": true,
                        "errorKind": "PermissionDenied"
                    }))
                }
                Err(error) => Err(anyhow!("network probe was not denied by the guard: {error}")),
            }
        }
        _ => bail!(
            "usage: freeze-fixtures MODEL INPUT OUTPUT | conformance MODEL FIXTURES | benchmark MODEL FIXTURES | worker MODEL [--block-network] | network-probe"
        ),
    }
}

fn require_argument_count(arguments: &[String], expected: usize) -> Result<()> {
    if arguments.len() != expected {
        bail!("unexpected argument count");
    }
    Ok(())
}

fn write_json(value: &impl Serialize) -> Result<()> {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    serde_json::to_writer_pretty(&mut output, value).context("failed to serialize output")?;
    output
        .write_all(b"\n")
        .context("failed to terminate output")
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum WorkerRequest {
    Encode {
        id: String,
        role: Role,
        text: String,
    },
    InjectPanic {
        id: String,
    },
    Shutdown {
        id: String,
    },
}

impl WorkerRequest {
    fn id(&self) -> &str {
        match self {
            Self::Encode { id, .. } | Self::InjectPanic { id } | Self::Shutdown { id } => id,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerResponse {
    id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    retained_token_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vector: Option<Vec<f32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
}

fn run_worker(model_dir: PathBuf, block_network: bool) -> Result<()> {
    if block_network {
        install_network_block()?;
    }
    let model = StrictPotionModel::load(&model_dir, DEFAULT_RETAINED_TOKEN_LIMIT)?;
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    write_json(&serde_json::json!({
        "ready": true,
        "modelLoadedOnce": true,
        "retainedTokenLimit": DEFAULT_RETAINED_TOKEN_LIMIT,
        "networkBlocked": block_network
    }))?;

    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = input
            .by_ref()
            .take((MAX_WORKER_FRAME_BYTES + 1) as u64)
            .read_until(b'\n', &mut line)
            .context("failed to read worker frame")?;
        if read == 0 {
            break;
        }
        if line.len() > MAX_WORKER_FRAME_BYTES || !line.ends_with(b"\n") {
            drain_to_newline(&mut input)?;
            write_json(&WorkerResponse {
                id: String::new(),
                ok: false,
                retained_token_count: None,
                vector: None,
                error_code: Some("FRAME_TOO_LARGE".to_owned()),
            })?;
            continue;
        }
        let request: WorkerRequest = match serde_json::from_slice(&line) {
            Ok(request) => request,
            Err(_) => {
                write_json(&WorkerResponse {
                    id: String::new(),
                    ok: false,
                    retained_token_count: None,
                    vector: None,
                    error_code: Some("INVALID_FRAME".to_owned()),
                })?;
                continue;
            }
        };
        let id = request.id().to_owned();
        let should_shutdown = matches!(request, WorkerRequest::Shutdown { .. });
        let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match request {
            WorkerRequest::Encode { role, text, .. } => {
                let result = match role {
                    Role::Query => model.encode_query(&text),
                    Role::Document => model.encode_document(&text),
                };
                match result {
                    Ok(encoded) => WorkerResponse {
                        id,
                        ok: true,
                        retained_token_count: Some(encoded.retained_token_count),
                        vector: Some(encoded.vector),
                        error_code: None,
                    },
                    Err(error) => WorkerResponse {
                        id,
                        ok: false,
                        retained_token_count: None,
                        vector: None,
                        error_code: Some(error.code().to_owned()),
                    },
                }
            }
            WorkerRequest::InjectPanic { .. } => panic!("injected worker boundary panic"),
            WorkerRequest::Shutdown { .. } => WorkerResponse {
                id,
                ok: true,
                retained_token_count: None,
                vector: None,
                error_code: None,
            },
        }));
        match handled {
            Ok(response) => write_json(&response)?,
            Err(_) => write_json(&WorkerResponse {
                id: request_id_after_panic(&line),
                ok: false,
                retained_token_count: None,
                vector: None,
                error_code: Some("NATIVE_PANIC_CONTAINED".to_owned()),
            })?,
        }
        if should_shutdown {
            break;
        }
    }
    std::panic::set_hook(default_hook);
    Ok(())
}

fn request_id_after_panic(frame: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(frame)
        .ok()
        .and_then(|value| {
            value
                .get("id")
                .and_then(|id| id.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

fn drain_to_newline(input: &mut impl BufRead) -> Result<()> {
    loop {
        let available = input.fill_buf().context("failed to drain worker frame")?;
        if available.is_empty() {
            return Ok(());
        }
        if let Some(position) = available.iter().position(|byte| *byte == b'\n') {
            input.consume(position + 1);
            return Ok(());
        }
        let length = available.len();
        input.consume(length);
    }
}

#[cfg(target_os = "linux")]
fn install_network_block() -> Result<()> {
    const BPF_LD: u16 = 0x00;
    const BPF_W: u16 = 0x00;
    const BPF_ABS: u16 = 0x20;
    const BPF_JMP: u16 = 0x05;
    const BPF_JEQ: u16 = 0x10;
    const BPF_K: u16 = 0x00;
    const BPF_RET: u16 = 0x06;
    const SECCOMP_RET_ALLOW: u32 = 0x7fff0000;
    const SECCOMP_RET_ERRNO: u32 = 0x00050000;
    const SECCOMP_MODE_FILTER: libc::c_ulong = 2;

    let denied_syscalls = [
        libc::SYS_socket,
        libc::SYS_socketpair,
        libc::SYS_connect,
        libc::SYS_bind,
        libc::SYS_listen,
        libc::SYS_accept,
        libc::SYS_accept4,
        libc::SYS_sendto,
        libc::SYS_sendmsg,
        libc::SYS_recvfrom,
        libc::SYS_recvmsg,
        libc::SYS_shutdown,
    ];
    let mut filters = Vec::<libc::sock_filter>::with_capacity(2 + denied_syscalls.len() * 2);
    filters.push(libc::sock_filter {
        code: BPF_LD | BPF_W | BPF_ABS,
        jt: 0,
        jf: 0,
        k: 0,
    });
    for syscall in denied_syscalls {
        filters.push(libc::sock_filter {
            code: BPF_JMP | BPF_JEQ | BPF_K,
            jt: 0,
            jf: 1,
            k: syscall as u32,
        });
        filters.push(libc::sock_filter {
            code: BPF_RET | BPF_K,
            jt: 0,
            jf: 0,
            k: SECCOMP_RET_ERRNO | libc::EPERM as u32,
        });
    }
    filters.push(libc::sock_filter {
        code: BPF_RET | BPF_K,
        jt: 0,
        jf: 0,
        k: SECCOMP_RET_ALLOW,
    });
    let program = libc::sock_fprog {
        len: u16::try_from(filters.len()).context("seccomp filter is too large")?,
        filter: filters.as_mut_ptr(),
    };
    let no_new_privileges = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if no_new_privileges != 0 {
        return Err(io::Error::last_os_error()).context("failed to enable no-new-privileges");
    }
    let installed = unsafe {
        libc::prctl(
            libc::PR_SET_SECCOMP,
            SECCOMP_MODE_FILTER,
            &program as *const libc::sock_fprog,
        )
    };
    if installed != 0 {
        return Err(io::Error::last_os_error()).context("failed to install network seccomp filter");
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn install_network_block() -> Result<()> {
    bail!("network blocking is implemented only for the pinned Linux target")
}
