"use client";

import Link from "next/link";
import { useState } from "react";

type Panel = "login" | "register" | "find-id" | "reset";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [panel, setPanel] = useState<Panel>("login");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitAuth(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const path = panel === "login" ? "/api/auth/login" : "/api/auth/register";
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
      // Landing dashboard — never auto-redirect to account registration.
      window.location.href = "/";
    } finally {
      setBusy(false);
    }
  }

  async function submitRecovery(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const path =
        panel === "find-id" ? "/api/auth/find-id" : "/api/auth/password-reset/request";
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "요청 실패");
        return;
      }
      setInfo(body.message ?? "요청이 접수되었습니다. 등록된 이메일이면 안내 메일을 보냅니다.");
    } finally {
      setBusy(false);
    }
  }

  const title =
    panel === "login"
      ? "로그인"
      : panel === "register"
        ? "회원가입"
        : panel === "find-id"
          ? "아이디 찾기"
          : "비밀번호 재설정";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-8">
      <div>
        <p className="text-sm text-muted-foreground">미리매수</p>
        <h1 className="text-3xl font-semibold">{title}</h1>
      </div>

      {panel === "find-id" || panel === "reset" ? (
        <form className="flex flex-col gap-3" onSubmit={(e) => void submitRecovery(e)}>
          <p className="text-sm text-muted-foreground">
            {panel === "find-id"
              ? "가입 시 사용한 이메일을 입력하면, 등록된 경우 로그인 아이디(이메일) 안내를 보냅니다."
              : "등록 이메일로 만료되는 일회용 재설정 링크를 보냅니다."}
          </p>
          <input
            className="rounded border border-border bg-background px-3 py-2"
            placeholder="등록 이메일"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-foreground px-4 py-2 text-background disabled:opacity-50"
          >
            {busy ? "처리 중…" : "요청하기"}
          </button>
        </form>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={(e) => void submitAuth(e)}>
          {panel === "register" ? (
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
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-foreground px-4 py-2 text-background disabled:opacity-50"
          >
            {busy ? "처리 중…" : panel === "login" ? "로그인" : "가입"}
          </button>
        </form>
      )}

      {info ? <p className="text-sm text-emerald-400">{info}</p> : null}
      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      <div className="flex flex-col gap-2 text-sm">
        {panel === "login" ? (
          <>
            <button type="button" className="text-left underline" onClick={() => setPanel("find-id")}>
              아이디 찾기
            </button>
            <button type="button" className="text-left underline" onClick={() => setPanel("reset")}>
              비밀번호 재설정
            </button>
            <button
              type="button"
              className="text-left underline"
              onClick={() => setPanel("register")}
            >
              회원가입
            </button>
          </>
        ) : (
          <button
            type="button"
            className="text-left underline"
            onClick={() => {
              setPanel("login");
              setInfo(null);
              setError(null);
            }}
          >
            로그인으로
          </button>
        )}
        <Link href="/" className="underline">
          홈
        </Link>
      </div>
    </main>
  );
}
