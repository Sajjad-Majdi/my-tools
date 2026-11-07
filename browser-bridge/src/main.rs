//! Browser Bridge relay + CLI in one dependency-free binary.
//!
//!   bb serve | bb start              run the relay (start = detached, no window)
//!   bb profiles                      connected Chrome profiles
//!   bb [-p PROFILE] TYPE [JSON]      one command, e.g. bb -p work text {"tab":"github","max":3000}
//!
//! One port (127.0.0.1:8765): a request starting with "GET " is the extension's WebSocket,
//! anything else is a CLI call: four lines (token, profile, timeout seconds, command JSON),
//! answered with one JSON line. The CLI starts the relay itself when nothing is listening.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const ADDR: &str = "127.0.0.1:8765";

struct Client { label: String, conn: u64, since: Instant, out: Arc<Mutex<TcpStream>> }
struct State { clients: Mutex<HashMap<String, Client>>, pending: Mutex<HashMap<u64, Sender<String>>>, next: AtomicU64 }
static STATE: OnceLock<State> = OnceLock::new();
static TOKEN: OnceLock<String> = OnceLock::new();
fn st() -> &'static State { STATE.get().unwrap() }

fn token() -> &'static str {
    TOKEN.get_or_init(|| {
        let dir = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
        let p = if dir.join("token.txt").exists() { dir.join("token.txt") } else { dir.join("..").join("token.txt") };
        std::fs::read_to_string(p).expect("token.txt").trim().to_string()
    })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("serve") => serve(),
        Some("start") => { spawn_relay(); }
        None => eprintln!("usage: bb serve | start | profiles | [-p PROFILE] TYPE [JSON]"),
        _ => std::process::exit(cli(args)),
    }
}

// ------------------------------------------------------------------------------------ relay

fn serve() {
    STATE.set(State { clients: Mutex::new(HashMap::new()), pending: Mutex::new(HashMap::new()), next: AtomicU64::new(1) }).ok();
    let listener = match TcpListener::bind(ADDR) { Ok(l) => l, Err(_) => return }; // already running
    for s in listener.incoming().flatten() {
        std::thread::spawn(move || { let _ = s.set_nodelay(true); let _ = handle(s); });
    }
}

fn handle(s: TcpStream) -> std::io::Result<()> {
    let mut first = [0u8; 4];
    s.peek(&mut first)?;
    if &first == b"GET " { websocket(s) } else { cli_call(s) }
}

fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

fn cli_call(s: TcpStream) -> std::io::Result<()> {
    let mut r = BufReader::new(s.try_clone()?);
    let mut line = || { let mut l = String::new(); r.read_line(&mut l).map(|_| l.trim_end_matches(['\r', '\n']).to_string()) };
    let (tok, profile, timeout, cmd) = (line()?, line()?, line()?, line()?);
    let mut w = s;
    if !ct_eq(&tok, token()) { return writeln!(w, "{{\"error\":\"bad token\"}}"); }
    if profile == "!profiles" { return writeln!(w, "{}", profiles_json()); }
    let reply = dispatch(&profile, timeout.parse().unwrap_or(90), &cmd);
    writeln!(w, "{}", reply)
}

fn profiles_json() -> String {
    let c = st().clients.lock().unwrap();
    let items: Vec<String> = c.iter().map(|(i, c)| format!("{{\"instance\":\"{}\",\"label\":\"{}\",\"up_s\":{}}}",
        esc(i), esc(&c.label), c.since.elapsed().as_secs())).collect();
    format!("[{}]", items.join(","))
}

fn pick(profile: &str) -> Result<(String, Arc<Mutex<TcpStream>>), String> {
    let p = profile.to_lowercase();
    for attempt in 0..40 { // a just-started relay gets its extensions within about a second
        {
            let c = st().clients.lock().unwrap();
            let hits: Vec<_> = c.iter().filter(|(i, c)| p.is_empty() || **i == profile || c.label.to_lowercase().contains(&p)).collect();
            if hits.len() == 1 { return Ok((hits[0].0.clone(), hits[0].1.out.clone())); }
            if hits.len() > 1 || (attempt == 39) {
                let names: Vec<String> = c.values().map(|c| c.label.clone()).collect();
                return Err(format!("{} profile(s) match '{}'; connected: {:?}", if hits.is_empty() { "no" } else { "several" }, profile, names));
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    unreachable!()
}

fn dispatch(profile: &str, timeout: u64, cmd: &str) -> String {
    let (_, out) = match pick(profile) { Ok(x) => x, Err(e) => return format!("{{\"error\":\"{}\"}}", esc(&e)) };
    let id = st().next.fetch_add(1, Ordering::Relaxed);
    let body = cmd.trim().trim_start_matches('{');
    let msg = format!("{{\"id\":{}{}{}", id, if body.trim_start().starts_with('}') { "" } else { "," }, body);
    let (tx, rx) = channel();
    st().pending.lock().unwrap().insert(id, tx);
    let sent = send_frame(&out, 1, msg.as_bytes());
    let reply = match sent {
        Err(_) => "{\"error\":\"extension connection lost\"}".to_string(),
        Ok(_) => rx.recv_timeout(Duration::from_secs(timeout)).unwrap_or_else(|_| "{\"error\":\"the extension did not answer in time\"}".into()),
    };
    st().pending.lock().unwrap().remove(&id);
    reply
}

fn websocket(s: TcpStream) -> std::io::Result<()> {
    let mut r = BufReader::new(s.try_clone()?);
    let mut req = String::new();
    r.read_line(&mut req)?;
    let mut key = String::new();
    loop {
        let mut l = String::new();
        if r.read_line(&mut l)? == 0 || l == "\r\n" { break; }
        if let Some((k, v)) = l.split_once(':') { if k.eq_ignore_ascii_case("sec-websocket-key") { key = v.trim().to_string(); } }
    }
    let target = req.split_whitespace().nth(1).unwrap_or("");
    let q: HashMap<String, String> = target.split_once('?').map(|(_, q)| q).unwrap_or("").split('&')
        .filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_string(), pct(v))).collect();
    let mut w = s;
    if !ct_eq(q.get("token").map(|s| s.as_str()).unwrap_or(""), token()) || key.is_empty() {
        return w.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    }
    let accept = b64(&sha1(format!("{}258EAFA5-E914-47DA-95CA-C5AB0DC85B11", key).as_bytes()));
    w.write_all(format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n", accept).as_bytes())?;
    let instance = q.get("instance").cloned().unwrap_or_default();
    let conn = st().next.fetch_add(1, Ordering::Relaxed);
    let out = Arc::new(Mutex::new(w));
    st().clients.lock().unwrap().insert(instance.clone(), Client {
        label: q.get("label").cloned().unwrap_or_else(|| instance.clone()), conn, since: Instant::now(), out: out.clone() });
    let res = ws_loop(&mut r, &out);
    let mut c = st().clients.lock().unwrap();
    if c.get(&instance).map(|c| c.conn) == Some(conn) { c.remove(&instance); }
    res
}

fn ws_loop(r: &mut BufReader<TcpStream>, out: &Arc<Mutex<TcpStream>>) -> std::io::Result<()> {
    let mut msg: Vec<u8> = Vec::new();
    loop {
        let mut h = [0u8; 2];
        r.read_exact(&mut h)?;
        let (fin, op, masked) = (h[0] & 0x80 != 0, h[0] & 0x0f, h[1] & 0x80 != 0);
        let mut n = (h[1] & 0x7f) as u64;
        if n == 126 { let mut b = [0u8; 2]; r.read_exact(&mut b)?; n = u16::from_be_bytes(b) as u64; }
        else if n == 127 { let mut b = [0u8; 8]; r.read_exact(&mut b)?; n = u64::from_be_bytes(b); }
        let mut mask = [0u8; 4];
        if masked { r.read_exact(&mut mask)?; }
        let mut data = vec![0u8; n as usize];
        r.read_exact(&mut data)?;
        if masked { for (i, b) in data.iter_mut().enumerate() { *b ^= mask[i & 3]; } }
        match op {
            8 => { let _ = send_frame(out, 8, &[]); return Ok(()); }
            9 => { send_frame(out, 10, &data)?; continue; }
            10 => continue,
            _ => msg.extend_from_slice(&data),
        }
        if !fin { continue; }
        let text = String::from_utf8_lossy(&msg).into_owned();
        msg.clear();
        if let Some(rest) = text.strip_prefix("{\"id\":") {
            let id: u64 = rest.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0);
            if let Some(tx) = st().pending.lock().unwrap().remove(&id) { let _ = tx.send(text); }
        }
    }
}

fn send_frame(out: &Arc<Mutex<TcpStream>>, op: u8, data: &[u8]) -> std::io::Result<()> {
    let mut f = Vec::with_capacity(data.len() + 10);
    f.push(0x80 | op);
    match data.len() {
        n if n < 126 => f.push(n as u8),
        n if n < 65536 => { f.push(126); f.extend_from_slice(&(n as u16).to_be_bytes()); }
        n => { f.push(127); f.extend_from_slice(&(n as u64).to_be_bytes()); }
    }
    f.extend_from_slice(data);
    out.lock().unwrap().write_all(&f)
}

// ------------------------------------------------------------------------------------ CLI

fn spawn_relay() {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new(std::env::current_exe().unwrap()).arg("serve")
        .creation_flags(0x0000_0008 | 0x0800_0000 | 0x0000_0200) // DETACHED, NO_WINDOW, NEW_GROUP
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
}

fn connect() -> TcpStream {
    if let Ok(s) = TcpStream::connect(ADDR) { return s; }
    spawn_relay();
    for _ in 0..100 {
        std::thread::sleep(Duration::from_millis(20));
        if let Ok(s) = TcpStream::connect(ADDR) { return s; }
    }
    eprintln!("relay did not start"); std::process::exit(2)
}

fn cli(mut args: Vec<String>) -> i32 {
    let mut profile = String::new();
    if args[0] == "-p" && args.len() > 2 { profile = args[1].clone(); args.drain(..2); }
    let ty = args[0].clone();
    let json = args.get(1).cloned().unwrap_or_else(|| "{}".into());
    let (profile, cmd) = if ty == "profiles" { ("!profiles".to_string(), "{}".to_string()) } else {
        let body = json.trim().trim_start_matches('{');
        (profile, format!("{{\"type\":\"{}\"{}{}", esc(&ty), if body.trim_start().starts_with('}') { "" } else { "," }, body))
    };
    let timeout = field_num(&json, "timeout").unwrap_or(90);
    let mut s = connect();
    let _ = s.set_nodelay(true);
    if write!(s, "{}\n{}\n{}\n{}\n", token(), profile, timeout, cmd.replace('\n', " ")).is_err() { return 2; }
    let mut reply = String::new();
    let _ = BufReader::new(s).read_line(&mut reply);
    let reply = reply.trim_end();
    if ty == "shot" {
        if let Some(data) = field_str(reply, "data") {
            let path = field_str(&json, "out").map(|p| p.replace("\\\\", "\\")).unwrap_or_else(|| "shot.jpg".into());
            let path = std::path::absolute(&path).unwrap_or(path.into());
            if std::fs::write(&path, unb64(&data)).is_ok() { println!("{{\"saved\":\"{}\"}}", esc(&path.to_string_lossy())); return 0; }
        }
    }
    println!("{}", reply);
    if reply.starts_with("{\"error\"") { 1 } else { 0 }
}

fn field_str(json: &str, name: &str) -> Option<String> {
    let start = json.find(&format!("\"{}\":\"", name))? + name.len() + 4;
    let end = start + json[start..].find('"')?;
    Some(json[start..end].to_string())
}

fn field_num(json: &str, name: &str) -> Option<u64> {
    let start = json.find(&format!("\"{}\":", name))? + name.len() + 3;
    json[start..].trim_start().chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

// ------------------------------------------------------------------------------------ helpers

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c { '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"), '\n' => o.push_str("\\n"), '\r' => o.push_str("\\r"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)), c => o.push(c) }
    }
    o
}

fn pct(s: &str) -> String {
    let b = s.as_bytes();
    let mut o = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => o.push(b' '),
            b'%' if i + 2 < b.len() => {
                o.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap_or(b'?')); i += 2;
            }
            c => o.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&o).into_owned()
}

const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64(d: &[u8]) -> String {
    let mut o = String::new();
    for c in d.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 { o.push(if i <= c.len() { B64[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' }); }
    }
    o
}

fn unb64(s: &str) -> Vec<u8> {
    let mut map = [255u8; 256];
    for (i, &c) in B64.iter().enumerate() { map[c as usize] = i as u8; }
    let (mut o, mut acc, mut bits) = (Vec::with_capacity(s.len() * 3 / 4), 0u32, 0);
    for &c in s.as_bytes() {
        let v = map[c as usize];
        if v == 255 { continue; }
        acc = acc << 6 | v as u32; bits += 6;
        if bits >= 8 { bits -= 8; o.push((acc >> bits) as u8); }
    }
    o
}

fn sha1(msg: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut m = msg.to_vec();
    m.push(0x80);
    while m.len() % 64 != 56 { m.push(0); }
    m.extend_from_slice(&((msg.len() as u64) * 8).to_be_bytes());
    for chunk in m.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 { w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]); }
        for i in 16..80 { w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1); }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i { 0..=19 => ((b & c) | (!b & d), 0x5A827999), 20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC), _ => (b ^ c ^ d, 0xCA62C1D6) };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wi);
            e = d; d = c; c = b.rotate_left(30); b = a; a = t;
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e]) { *x = x.wrapping_add(y); }
    }
    let mut o = [0u8; 20];
    for i in 0..5 { o[4 * i..4 * i + 4].copy_from_slice(&h[i].to_be_bytes()); }
    o
}
