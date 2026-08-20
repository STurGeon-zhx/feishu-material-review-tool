# 飞书客户素材审核 POC

本项目是一个本地运行的单页 POC，用于真实验证以下链路：

1. 当前系统用户通过 OAuth 绑定自己的飞书账号。
2. 页面创建真实飞书多维表格和审核字段。
3. 批量上传 JPG、PNG、MP4；超过 20MB 自动使用素材分片上传。
4. 将 `file_token` 写入 Base 附件字段，并回读记录确认附件已经生效。
5. 第二批素材继续追加到同一个 Base，分享链接保持不变。
6. 在无痕窗口人工验证匿名查看和匿名编辑。

## 本地启动

环境要求：Node.js 24、npm、一个已发布的飞书企业自建应用。

```powershell
npm install
Copy-Item .env.example .env.local
```

生成 32 字节 Base64 加密密钥：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

将结果写入 `.env.local` 的 `TOKEN_ENCRYPTION_KEY`，再填写飞书应用的 App ID 和 App Secret：

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_REDIRECT_URI=http://localhost:3000/api/feishu/callback
TOKEN_ENCRYPTION_KEY=<32字节Base64密钥>
DATABASE_URL=file:./data/poc.db
DEMO_USER_ID=demo_user
```

启动：

```powershell
npm run dev
```

打开 <http://localhost:3000>。

## 飞书开发者后台配置

1. 创建企业自建应用，并添加“网页应用”能力。
2. 在安全设置中添加重定向 URL：`http://localhost:3000/api/feishu/callback`。
3. 为用户身份开通并由管理员审批以下权限：
   - 查看、评论、编辑和管理多维表格：`bitable:bitable`
   - 查看、评论、编辑和管理云空间中所有文件：`drive:drive`
   - 查看云文档权限设置：`docs:permission.setting:read`
   - 修改云文档权限设置：`docs:permission.setting:write_only`
4. 发布应用版本，并确保测试用户在应用可用范围内。
5. 如果匿名公开权限设置失败，在企业管理后台检查云文档对外分享策略。

## 验证流程

1. 点击“连接飞书”完成 OAuth。
2. 新建审核项目，并确认页面出现真实 Base 链接。
3. 第一批上传：约 2MB JPG、小型 PNG、约 10MB MP4、约 50MB MP4、约 200MB MP4。
4. 打开 Base，确认附件可以预览，状态和客户意见字段可以编辑。
5. 再上传第二批素材，确认仍使用原链接。
6. 复制链接到未登录飞书的无痕窗口，分别测试匿名查看和匿名编辑，并在验证区登记结果。

最终页面只有真实 OpenAPI 响应、Base 记录回读和人工无痕验证可以产生 PASS；测试桩不会写入验证结果。

## 开发验证

```powershell
npm test
npm run typecheck
npm run build
```

SQLite 文件、`.env.local`、上传临时文件和访问令牌不会提交到版本库。访问令牌使用 AES-256-GCM 加密保存；服务日志不输出令牌、App Secret 或素材内容。

当前依赖审计会报告 Drizzle ORM 的动态 SQL 标识符注入公告，且暂时没有可用修复版本。本项目不接受用户提供的表名、字段名或排序标识符，所有 SQL 标识符均为静态常量；官方发布修复版本后仍应及时升级并重新审计。

## 当前范围

不包含正式账号登录、客户管理、项目删除、素材删除同步、通知、飞书回调、审核状态反向同步、统计、AI、缩略图和云端部署。
