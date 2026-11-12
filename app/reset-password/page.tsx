"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

function ResetPasswordForm() {
  const search = useSearchParams();
  const tokenFromUrl = search.get("token") ?? "";
  const [token, setToken] = useState(tokenFromUrl);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, newPassword, confirmPassword }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "재설정 실패");
        return;
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "재설정 실패");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-8">
        <h1 className="text-2xl font-semibold">비밀번호가 변경되었습니다</h1>
        <p className="text-sm text-muted-foreground">
          기존 로그인 세션은 모두 무효화되었습니다. 새 비밀번호로 다시 로그인해 주세요.
        </p>
        <Link href="/login" className="underline">
          로그인
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-8">
      <div>
        <p className="text-sm text-muted-foreground">미리매수</p>
        <h1 className="text-3xl font-semibold">비밀번호 재설정</h1>
      </div>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        {!tokenFromUrl ? (
          <input
            className="rounded border border-border bg-background px-3 py-2"
            placeholder="재설정 토큰"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
          />
        ) : null}
        <input
          className="rounded border border-border bg-background px-3 py-2"
          placeholder="새 비밀번호 (8자 이상)"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          minLength={8}
        />
        <input
          className="rounded border border-border bg-background px-3 py-2"
          placeholder="새 비밀번호 확인"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          minLength={8}
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-foreground px-4 py-2 text-background disabled:opacity-50"
        >
          {busy ? "처리 중…" : "비밀번호 변경"}
        </button>
      </form>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      <Link href="/login" className="text-sm underline">
        로그인으로
      </Link>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-8">
          <p className="text-muted-foreground">불러오는 중…</p>
        </main>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
