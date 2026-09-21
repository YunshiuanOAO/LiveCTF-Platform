# 貢獻指南

## 開發環境

需要 Node.js 24 以上。安裝與初始化：

```bash
npm ci
cp .env.example .env
npm run setup
npm run seed
npm start
```

`npm run setup` 在 `.env` 已存在時會保留現有內容。請勿提交 `.env`、資料庫、參賽者資料或正式環境憑證。

## 測試

提交變更前至少執行：

```bash
npm test
```

涉及瀏覽器介面或完整賽事流程時，另執行：

```bash
npm run test:e2e
npm run test:full
```

完整測試說明請參閱 [TESTING-V2.md](TESTING-V2.md)。

## Pull request

- 每個 PR 聚焦一項功能或修正。
- 說明變更原因、驗證方式與可能影響。
- UI 變更請附上截圖。
- 不要在 issue、PR 或記錄中公開密碼、Cookie、學號或 flag。
