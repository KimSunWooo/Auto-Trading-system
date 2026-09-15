export type PlaybookId = "Level1_Stable" | "Level5_Swing" | "Level10_Aggressive";

export type Playbook = {
  id: PlaybookId;
  riskLevel: number;
  label: string;
  tone: string;
  summary: string;
  detail: string;
};

export const PLAYBOOKS: Playbook[] = [
  {
    id: "Level1_Stable",
    riskLevel: 1,
    label: "안정형",
    tone: "낮은 변동성",
    summary: "KODEX 200 정액 적립",
    detail: "지수 ETF를 나눠 담습니다. 급등보다 꾸준한 적립이 목적입니다.",
  },
  {
    id: "Level5_Swing",
    riskLevel: 5,
    label: "중립형",
    tone: "중위험 스윙",
    summary: "5일·20일 이동평균 스윙",
    detail: "단기 이평이 장기 이평을 뚫으면 사고, 아래로 꺾이면 팝니다.",
  },
  {
    id: "Level10_Aggressive",
    riskLevel: 10,
    label: "공격형",
    tone: "단기 추격",
    summary: "변동성 돌파 추격",
    detail: "당일 변동폭을 돌파한 종목을 짧게 따라붙습니다. 손실도 커질 수 있습니다.",
  },
];

export function playbookById(id: string | undefined): Playbook {
  return PLAYBOOKS.find((row) => row.id === id) ?? PLAYBOOKS[0];
}

export function playbookByRisk(level: number): Playbook {
  if (level <= 3) return PLAYBOOKS[0];
  if (level <= 7) return PLAYBOOKS[1];
  return PLAYBOOKS[2];
}
