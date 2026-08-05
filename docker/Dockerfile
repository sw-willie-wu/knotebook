FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo

# 先只複製 workspace manifest（package.json / lockfile / pnpm-workspace.yaml），
# 讓 `pnpm install` 這一層在只改了 src/* 而依賴沒變時可以命中 Docker layer
# cache，不必每次都重新下載/安裝全部依賴（下面 `COPY . .` 之後才複製其餘原始碼，
# 任何原始碼變動只會使該層之後的 layer 失效）。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm -r build
RUN pnpm --filter ./apps/server deploy --legacy --prod /out

FROM node:22-slim
WORKDIR /app
COPY --from=build /out .
# `pnpm deploy` 只依 apps/server/package.json 的 "files": ["dist"] 打包產物，不含
# drizzle/ migration 目錄（Task 3 審查 M8）；`src/db/migrate.ts` 在 runtime 用
# `dist/db/../../drizzle` 解析路徑（即 /app/drizzle），必須顯式複製過來，
# 否則 container 啟動時 runMigrations() 會找不到 migration 檔案而 fail fast。
COPY --from=build /repo/apps/server/drizzle ./drizzle
ENV NODE_ENV=production
# 不以 root 執行 process：node 官方 image 內建 uid 1000 的 "node" 使用者；
# 上面幾個 COPY 都在切換到這個 user 之前執行（此時仍是 root），複製出來的檔案
# 預設權限（644/755）本來就允許其他使用者讀取/執行，node 使用者不需要寫入
# /app 下任何東西（log 走 stdout），純唯讀存取即可正常運作。
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
