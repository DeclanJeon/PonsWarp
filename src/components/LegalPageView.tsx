import React from 'react';
import {
  Building2,
  FileText,
  LifeBuoy,
  ReceiptText,
  Scale,
  ShieldCheck,
} from 'lucide-react';

interface LegalPageViewProps {
  path: string;
  onNavigate: (path: string) => void;
}

interface LegalSection {
  title: string;
  body: string[];
}

interface LegalPage {
  title: string;
  eyebrow: string;
  summary: string;
  icon: React.ElementType;
  sections: LegalSection[];
}

const UPDATED_AT = '2026-05-14';

const PAGES: Record<string, LegalPage> = {
  '/legal': {
    title: '신뢰 및 정책 센터',
    eyebrow: 'LEGAL SIGNAL',
    summary:
      'PonsWarp의 사업자 정보, 개인정보 처리, 서비스 약관, 환불 기준, 문의 채널을 한곳에서 확인할 수 있습니다.',
    icon: FileText,
    sections: [
      {
        title: '운영 전제',
        body: [
          'PonsWarp는 직접 P2P 전송과 Cloud Drop 임시 보관 전송을 제공합니다.',
          'Cloud Drop은 파일 내용과 파일 메타데이터를 일정 기간 처리하므로 개인정보 및 콘텐츠 신고 절차가 필요합니다.',
          '사업자 정보는 2026년 5월 13일 발급된 사업자등록증명 기준으로 표시합니다.',
        ],
      },
    ],
  },
  '/privacy': {
    title: '개인정보처리방침',
    eyebrow: 'PRIVACY',
    summary:
      'Google 로그인, 세션, Cloud Drop 파일 메타데이터, 결제 식별자, 문의/신고 정보를 어떻게 처리하는지 안내합니다.',
    icon: ShieldCheck,
    sections: [
      {
        title: '처리하는 정보',
        body: [
          'Google 계정 식별자, 이메일, 이름, 프로필 이미지 URL, 로그인 세션 정보를 처리할 수 있습니다.',
          'Cloud Drop 사용 시 파일명, 경로, 크기, MIME 타입, 수정 시각, R2 object key, 다운로드 횟수, 만료 시각을 처리할 수 있습니다.',
          '유료 결제 시 Lemon Squeezy 또는 PayPal의 주문, 구독, 고객, 웹훅 식별자를 처리합니다. 카드 원문 정보는 PonsWarp가 저장하지 않습니다.',
        ],
      },
      {
        title: '보유 및 파기',
        body: [
          '무료 Cloud Drop 파일은 기본 24시간 보관 후 삭제 대상이 됩니다. 유료 Cloud Drop은 구매 조건에 따라 보관 기간이 달라집니다.',
          '계정, 결제, 감사, 신고 기록은 법령 준수, 분쟁 대응, 보안 목적에 필요한 기간 동안 보관될 수 있습니다.',
          '삭제 요청은 본인 확인 후 처리하며, 결제/회계 보존 의무가 있는 기록은 식별자를 최소화해 별도 보존할 수 있습니다.',
        ],
      },
      {
        title: '처리 위탁 및 이전',
        body: [
          'Cloudflare R2, Google OAuth, Lemon Squeezy, PayPal, 호스팅 및 Postgres 제공자를 서비스 운영에 사용할 수 있습니다.',
          '일부 제공자는 해외에 위치할 수 있으므로 실제 게시 전 수탁자, 이전 국가, 보유 기간을 확정해야 합니다.',
        ],
      },
      {
        title: '권리 행사',
        body: [
          '이용자는 개인정보 열람, 정정, 삭제, 처리정지, 동의 철회를 요청할 수 있습니다.',
          '요청은 문의 페이지의 개인정보 요청 채널로 접수합니다.',
        ],
      },
    ],
  },
  '/terms': {
    title: '이용약관',
    eyebrow: 'TERMS',
    summary:
      'P2P 직접 전송, Cloud Drop, 유료 보관, 금지 콘텐츠, 계정 제한, 서비스 책임 범위를 안내합니다.',
    icon: Scale,
    sections: [
      {
        title: '서비스 범위',
        body: [
          'P2P 직접 전송은 송신자와 수신자가 동시에 접속한 상태에서 브라우저 간 전송을 수행합니다.',
          'Cloud Drop은 파일을 임시 저장한 뒤 링크로 다운로드할 수 있도록 제공하는 기능입니다.',
          '무료 P2P 직접 전송은 앱 정책상 용량 제한을 두지 않는 것을 핵심 컨셉으로 유지합니다.',
        ],
      },
      {
        title: '이용자 의무',
        body: [
          '불법 콘텐츠, 악성코드, 권리 침해 자료, 개인정보 침해 자료, 서비스 남용 목적의 업로드를 금지합니다.',
          '공개 링크를 받은 사람이 파일에 접근할 수 있으므로 링크 공유와 보관 기간 관리 책임은 이용자에게 있습니다.',
        ],
      },
      {
        title: '제한 및 중단',
        body: [
          '불법 신고, 보안 위험, 결제 분쟁, 시스템 보호가 필요한 경우 Cloud Drop 링크나 계정 이용이 제한될 수 있습니다.',
          'Cloud Drop 파일은 만료, 신고 처리, 장애, 정책 위반에 따라 삭제될 수 있습니다.',
        ],
      },
    ],
  },
  '/refund': {
    title: '환불 및 구독 해지 정책',
    eyebrow: 'BILLING',
    summary:
      'Drop Pass, 월 구독, Lemon Squeezy 기본 결제, PayPal 대체 결제의 환불 기준을 안내합니다.',
    icon: ReceiptText,
    sections: [
      {
        title: '결제 제공자',
        body: [
          'PonsWarp의 기본 결제 경로는 Lemon Squeezy이며, PayPal은 대체 결제 수단으로 제공될 수 있습니다.',
          '실제 환불 처리는 결제 제공자의 거래 상태, 분쟁 상태, 정산 조건에 따라 달라질 수 있습니다.',
        ],
      },
      {
        title: 'Drop Pass',
        body: [
          'Drop Pass는 구매 후 Cloud Drop 업로드 권한에 적용되기 전에는 환불 가능성을 우선 검토합니다.',
          '권한이 Cloud Drop 업로드에 사용되어 저장 공간과 링크가 발급된 경우에는 디지털 서비스 제공 개시로 보아 환불 제한이 적용될 수 있습니다.',
          '업로드 실패나 서비스 장애로 권한이 정상 제공되지 않은 경우에는 재발급 또는 환불을 검토합니다.',
        ],
      },
      {
        title: '월 구독',
        body: [
          '구독은 다음 결제 주기 전 해지할 수 있으며, 해지 후 남은 기간의 제공 범위는 결제 화면과 결제 제공자 정책에 따라 안내합니다.',
          '환불 불가 조건이나 부분 환불 조건은 결제 전 화면과 본 정책에 함께 표시합니다.',
        ],
      },
    ],
  },
  '/commerce-disclosure': {
    title: '사업자 정보',
    eyebrow: 'BUSINESS',
    summary:
      '한국 사업자 운영에 필요한 통신판매 및 고객 응대 정보를 표시하는 페이지입니다.',
    icon: Building2,
    sections: [
      {
        title: '사업자 표시 항목',
        body: [
          '상호: 폰스링크',
          '대표자 성명: 전형동',
          '사업자등록번호: 711-14-02973',
          '사업장 소재지: 인천광역시 부평구 부평대로167번길 58-9, 4동 403호(청천동, 세종대원빌라)',
          '개업일: 2025년 12월 06일',
          '사업자등록일: 2025년 12월 09일',
          '업태: 정보통신업, 소매업',
          '종목: 시스템 소프트웨어 개발 및 공급업, 전자상거래 소매업, 응용 소프트웨어 개발 및 공급업, 컴퓨터 프로그래밍 서비스업',
          '통신판매업 신고번호: 사업자등록증명에는 기재되어 있지 않으며, 신고 완료 시 본 페이지에 표시합니다.',
          '대표 전자우편주소: ponslink@gmail.com',
        ],
      },
      {
        title: '증명 기준',
        body: [
          '위 사업자 정보는 2026년 5월 13일 부평세무서장이 발급한 사업자등록증명 기준입니다.',
          '공동사업자는 해당사항이 없습니다.',
        ],
      },
    ],
  },
  '/contact': {
    title: '문의 및 신고',
    eyebrow: 'SUPPORT',
    summary:
      '고객지원, 개인정보 권리 행사, 보안 제보, 불법 콘텐츠 신고를 접수하는 채널입니다.',
    icon: LifeBuoy,
    sections: [
      {
        title: '운영 채널',
        body: [
          '고객지원 이메일: ponslink@gmail.com',
          '개인정보 요청 이메일: ponslink@gmail.com',
          '보안 제보 이메일: ponslink@gmail.com',
          '불법 콘텐츠 및 권리 침해 신고: ponslink@gmail.com',
        ],
      },
      {
        title: '신고 시 필요한 정보',
        body: [
          'Cloud Drop 링크 또는 share ID, 신고 사유, 권리 침해 증빙, 회신 가능한 연락처를 함께 보내야 빠르게 확인할 수 있습니다.',
          '긴급 보안 신고는 제목에 SECURITY를 포함해 접수하도록 안내하는 것이 좋습니다.',
        ],
      },
    ],
  },
};

const NAV_ITEMS = [
  ['/legal', '정책 센터'],
  ['/privacy', '개인정보'],
  ['/terms', '약관'],
  ['/refund', '환불'],
  ['/commerce-disclosure', '사업자'],
  ['/contact', '문의'],
] as const;

const LegalPageView: React.FC<LegalPageViewProps> = ({ path, onNavigate }) => {
  const page = PAGES[path] || PAGES['/legal'];
  const Icon = page.icon;

  return (
    <div className="relative h-full w-full px-4 pb-10 pt-28 md:pt-32">
      <div className="mx-auto h-full max-w-5xl overflow-y-auto pb-16">
        <div className="mb-6 flex flex-wrap gap-2">
          {NAV_ITEMS.map(([itemPath, label]) => (
            <button
              key={itemPath}
              type="button"
              onClick={() => onNavigate(itemPath)}
              className={`rounded-full border px-3 py-2 text-xs font-bold tracking-wider transition-colors ${
                path === itemPath
                  ? 'border-cyan-300/60 bg-cyan-400/15 text-cyan-100'
                  : 'border-white/10 bg-black/35 text-gray-400 hover:bg-white/10 hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <section className="rounded-2xl border border-cyan-400/20 bg-black/50 p-5 shadow-[0_0_36px_rgba(6,182,212,0.12)] backdrop-blur-xl md:p-8">
          <div className="mb-8 flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
            <div className="max-w-3xl">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-cyan-400/25 bg-cyan-500/10 px-3 py-1">
                <Icon className="h-4 w-4 text-cyan-300" />
                <span className="text-[10px] font-bold tracking-[0.2em] text-cyan-200">
                  {page.eyebrow}
                </span>
              </div>
              <h2 className="brand-font text-3xl font-black leading-tight text-white md:text-5xl">
                {page.title}
              </h2>
              <p className="mt-4 text-sm leading-relaxed text-gray-300 md:text-base">
                {page.summary}
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-xs font-mono text-gray-400">
              최종 수정일
              <br />
              <span className="text-gray-200">{UPDATED_AT}</span>
            </div>
          </div>

          <div className="space-y-5">
            {page.sections.map(section => (
              <article
                key={section.title}
                className="rounded-xl border border-white/10 bg-gray-950/60 p-4"
              >
                <h3 className="mb-3 text-lg font-bold text-white">
                  {section.title}
                </h3>
                <div className="space-y-2">
                  {section.body.map(item => (
                    <p
                      key={item}
                      className="text-sm leading-relaxed text-gray-300"
                    >
                      {item}
                    </p>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};

export default LegalPageView;
