"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type MeResponse = {
  user: {
    id: string;
    email: string;
    displayName: string;
    role: string;
  } | null;
  accounts?: Array<{
    id: string;
    displayName: string;
    accountNumberMasked: string | null;
    environment: string;
    appKeyRegistered: boolean;
    appSecretRegistered: boolean;
    status: string;
  }>;
};

export default function MyPage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alias, setAlias] = useState("내 PAPER 계좌");
  const [accountNo, setAccountNo] = useState("");
  const [appKey, setAppKey] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [rotateAccountNo, setRotateAccountNo] = useState("");
  const [rotateKey, setRotateKey] = useState("");
  const [rotateSecret, setRotateSecret] = useState("");

  async function refresh() {
    const res = await fetch("/api/auth/me");
    if (res.status === 401) {
      setMe({ user: null });
      return;
    }
    setMe(await res.json());
  }

  useEffect(() => {
    void refresh().catch((err) => setError(err instanceof Error ? err.message : "load failed"));
  }, []);

  async function connectAccount(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/accounts/paper", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alias, accountNo, appKey, appSecret, environment: "PAPER" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "connect failed");
      setMessage(body.note ?? "연결됨");
      setAppKey("");
      setAppSecret("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "connect failed");
    } finally {
      setBusy(false);
    }
  }

  async function updateCredentials(e: React.FormEvent, accountId: string) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/paper/${accountId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountNo: rotateAccountNo,
          appKey: rotateKey,
          appSecret: rotateSecret,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "update failed");
      setMessage(
        body.mode === "switch"
          ? `계좌 변경 완료 (새 ID ${body.brokerAccountId}). 이전 계좌 이력은 보존됩니다.`
          : (body.note ?? "인증정보 수정 완료"),
      );
      setRotateKey("");
      setRotateSecret("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "update failed");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  if (!me) return <main className="p-8">불러오는 중…</main>;
  if (!me.user) {
    return (
      <main className="mx-auto max-w-lg p-8">
        <h1 className="text-2xl font-semibold">마이페이지</h1>
        <p className="mt-4 text-muted-foreground">로그인이 필요합니다.</p>
        <Link className="mt-4 inline-block underline" href="/login">
          로그인
        </Link>
      </main>
    );
  }

  const defaultAccount = (me.accounts ?? [])[0];

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">미리매수</p>
          <h1 className="text-3xl font-semibold tracking-tight">마이페이지</h1>
        </div>
        <button type="button" className="text-sm underline" onClick={() => void logout()}>
          로그아웃
        </button>
      </header>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">계정</h2>
        <p>이메일: {me.user.email}</p>
        <p>이름: {me.user.displayName}</p>
        <p>역할: {me.user.role}</p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">PAPER 계좌</h2>
        {(me.accounts ?? []).length === 0 ? (
          <p className="text-muted-foreground">연결된 PAPER 계좌가 없습니다.</p>
        ) : (
          <ul className="space-y-2">
            {(me.accounts ?? []).map((a) => (
              <li key={a.id} className="rounded border border-border p-3 text-sm">
                <div className="font-medium">{a.displayName}</div>
                <div>계좌: {a.accountNumberMasked ?? "****"}</div>
                <div>환경: {a.environment} (REAL LOCKED)</div>
                <div>APP KEY: {a.appKeyRegistered ? "registered" : "missing"}</div>
                <div>APP SECRET: {a.appSecretRegistered ? "registered" : "missing"}</div>
                <div>상태: {a.status}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(me.accounts ?? []).length === 0 ? (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">PAPER 계좌 연결</h2>
          <p className="text-sm text-muted-foreground">
            REAL 계좌는 비활성화되어 있습니다. 저장 전 읽기 전용 잔고 조회만 수행합니다.
          </p>
          <form className="flex flex-col gap-3" onSubmit={(e) => void connectAccount(e)}>
            <input
              className="rounded border border-border bg-background px-3 py-2"
              placeholder="별칭"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
            />
            <input
              className="rounded border border-border bg-background px-3 py-2"
              placeholder="계좌번호"
              value={accountNo}
              onChange={(e) => setAccountNo(e.target.value)}
              required
            />
            <input
              className="rounded border border-border bg-background px-3 py-2"
              placeholder="APP KEY"
              value={appKey}
              onChange={(e) => setAppKey(e.target.value)}
              required
            />
            <input
              className="rounded border border-border bg-background px-3 py-2"
              placeholder="APP SECRET"
              type="password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              required
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-foreground px-4 py-2 text-background disabled:opacity-50"
            >
              {busy ? "검증 중…" : "연결 확인 후 저장"}
            </button>
          </form>
        </section>
      ) : defaultAccount ? (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">인증정보 수정 / 계좌 변경</h2>
          <p className="text-sm text-muted-foreground">
            동일 계좌번호면 APP KEY·SECRET만 교체합니다. 다른 계좌번호면 새 PAPER 계좌를 만들고 이전
            계좌는 DISABLED로 보존합니다. 자동매매·미확인·미체결이 있으면 계좌 변경이 거부됩니다.
          </p>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => void updateCredentials(e, defaultAccount.id)}
          >
            <input
              className="rounded border border-border bg-background px-3 py-2"
              placeholder="계좌번호 (동일=인증 수정 / 다름=계좌 변경)"
              value={rotateAccountNo}
              onChange={(e) => setRotateAccountNo(e.target.value)}
              required
            />
            <input
              className="rounded border border-border bg-background px-3 py-2"
              placeholder="APP KEY"
              value={rotateKey}
              onChange={(e) => setRotateKey(e.target.value)}
              required
            />
            <input
              className="rounded border border-border bg-background px-3 py-2"
              placeholder="APP SECRET"
              type="password"
              value={rotateSecret}
              onChange={(e) => setRotateSecret(e.target.value)}
              required
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-foreground px-4 py-2 text-background disabled:opacity-50"
            >
              {busy ? "검증 중…" : "저장"}
            </button>
          </form>
        </section>
      ) : null}

      {message ? <p className="text-sm text-emerald-400">{message}</p> : null}
      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      <p className="text-sm text-muted-foreground">
        <Link href="/" className="underline">
          대시보드
        </Link>
      </p>
    </main>
  );
}
