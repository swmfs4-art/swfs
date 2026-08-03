# 선거 기록 대조 아카이브

## 새 항목 추가하는 법 (코딩 지식 불필요)

`data.json` 파일을 열고 `"entries"` 배열 안에 아래 형식을 복사해서 붙여넣고 내용만 바꾸면 됩니다.

```json
{
  "id": "issue-03",
  "status": "contested",
  "statusLabel": "공방 진행",
  "tag": "ISSUE 03",
  "date": "2026년 O월",
  "title": "여기에 의혹 제목",
  "claim": "여기에 제기된 주장 내용",
  "response": "여기에 공식 답변/조사 결과 내용",
  "sources": "출처: OOO 보도, OOO 판결문 등"
}
```

- `status`는 `dismissed`(기각/빨간 스탬프), `contested`(공방중/노란 스탬프), `confirmed`(사실확인/초록 스탬프) 중 하나로 적어주세요.
- 새 항목은 다른 항목과 쉼표(`,`)로 구분해서 이어붙이면 됩니다.
- 저장 후 `index.html`을 브라우저로 열면 바로 반영된 걸 확인할 수 있어요.

## GitHub Pages에 올리는 법

1. github.com 에서 새 저장소(Repository)를 만듭니다 (예: `election-archive`).
2. 이 폴더 안의 파일 4개(`index.html`, `style.css`, `script.js`, `data.json`)를 저장소에 업로드합니다.
3. 저장소의 **Settings → Pages** 메뉴에서 Source를 `main` 브랜치, `/ (root)` 폴더로 설정하고 저장합니다.
4. 몇 분 후 `https://[본인아이디].github.io/election-archive` 주소로 접속하면 사이트가 보입니다.

## 앞으로 뉴스 업데이트하는 법

완전 자동화는 안 되지만, 저(Claude)에게 "최신 뉴스 반영해서 항목 추가해줘"라고 요청하시면
그때그때 검색해서 `data.json`에 넣을 항목을 만들어드릴 수 있어요. 그 내용을 복사해서
GitHub 저장소의 `data.json`에 붙여넣기만 하면 사이트에 반영됩니다.
