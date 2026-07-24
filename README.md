# Narralume（叙影）

Narralume 是一个本地优先的长篇故事视觉说书生产平台，将小说、故事、纪实文本等长内容转化为可审稿、可恢复、可追溯来源的旁白视频。

《北派盗墓笔记》是第一个真实验证项目，但 Narralume 不绑定某一本书或某一种题材。

## 产品方向

```text
长篇文本书库
-> 章节与事件索引
-> 故事弧和分集
-> 忠实整理与包装
-> 人物、场景和道具资产
-> 视觉段和候选图片
-> TTS 与字幕时间轴
-> ffmpeg 静图视频
-> 分片恢复和导出
```

第一版专注于静图、旁白、字幕、轻微镜头运动和淡化换图，不做角色动画、口型同步、无限画布和 AI 视频生成。

## 技术栈

- 前端：React + TypeScript + Vite + Tailwind CSS
- 后端：Fastify + TypeScript
- 数据：SQLite + 本地文件
- 视频：系统 `ffmpeg` / `ffprobe`
- 任务：SQLite 持久化任务 + 本地 Worker

## 开发

要求 Node.js 22 或更高版本。

```bash
npm install
npm run dev
```

- 前端默认地址：`http://localhost:5173`
- 后端默认地址：`http://localhost:3100`
- 健康检查：`http://localhost:3100/api/health`

## 验证

```bash
npm run typecheck
npm test
npm run build
```

详细设计见 [docs/project-design.md](docs/project-design.md)。
