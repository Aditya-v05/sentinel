import { useState, type FormEvent } from "react";
import { api, setToken } from "../lib/api";

export default function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { token } = await api<{ token: string }>("/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      setToken(token);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="main" style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
      <form onSubmit={submit} className="card" style={{ width: 340 }}>
        <div className="brand" style={{ marginBottom: 16 }}>
          Audience Intelligence
          <small>Sign in</small>
        </div>
        <input
          className="input"
          type="password"
          autoFocus
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          style={{ width: "100%", marginBottom: 8 }}
        />
        <button className="btn" disabled={busy || !password} style={{ width: "100%" }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {error && <p className="note neg">{error}</p>}
        <p className="note">The password is APP_PASSWORD in backend/.env. Sessions last 12 hours.</p>
      </form>
    </div>
  );
}
