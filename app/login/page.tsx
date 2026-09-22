"use client";

import Link from "next/link";
import { useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const path = mode === "login" ? "/api/auth/login" : "/api/auth/register";
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, displayName }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error ?? "failed");
      return;
    }
    window.location.href = "/mypage";
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-8">
      <div>
        <p className="text-sm text-muted-foreground">미리매수</p>
        <h1 className="text-3xl font-semibold">{mode === "login" ? "로그인" : "회원가입"}</h1>
      </div>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        {mode === "register" ? (
          <input
            className="rounded border border-border bg-background px-3 py-2"
            placeholder="표시 이름"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        ) : null}
        <input
          className="rounded border border-border bg-background px-3 py-2"
          placeholder="이메일"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="rounded border border-border bg-background px-3 py-2"
          placeholder="비밀번호 (8자 이상)"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
        <button type="submit" className="rounded bg-foreground px-4 py-2 text-background">
          {mode === "login" ? "로그인" : "가입"}
        </button>
      </form>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      <button
        type="button"
        className="text-left text-sm underline"
        onClick={() => setMode(mode === "login" ? "register" : "login")}
      >
        {mode === "login" ? "회원가입" : "로그인으로"}
      </button>
      <Link href="/" className="text-sm underline">
        홈
      </Link>
    </main>
  );
}
