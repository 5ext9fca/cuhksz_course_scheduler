# 港中深课程规划器

在本机刷新 SIS 学期开课目录和个人修读记录，选择课程，浏览符合条件的课表。已有 JSON 可直接导入。首次启动目录为空。

## 启动

安装 uv 和本机 Chrome。规划器使用 [cuhksz_sis_scraper](https://github.com/5ext9fca/cuhksz_sis_scraper) 的 Python API。当前工作区的源码位于相邻目录 `../sis_scrawler`。新环境请将 scraper 检出到该位置，或在 `pyproject.toml` 的 `tool.uv.sources` 中指定其实际路径并重新运行 `uv sync`。两项目通过可编辑依赖连接，scraper 的更新可直接用于规划器。专业修读计划 PDF 解析需要 Poppler 的 `pdftotext`。

在本项目目录运行：

```sh
uv run course-planner
```

命令在回环地址启动服务并打开浏览器。界面随 Python 包提供。要使用其他配置目录、数据位置或端口：

```sh
uv run course-planner --config-dir ../sis_scrawler --data-dir .planner --port 8765 --no-open
```

默认读取启动目录的 `profile.toml` 和 `browser.toml`。已有 scraper 配置可用上面的 `--config-dir` 命令直接复用；也可用 `--profile 路径` 和 `--browser-config 路径` 单独指定文件。显式文件路径相对于启动目录解析，优先于目录默认值。

首次创建个人配置可将 `profile.example.toml` 复制为 `profile.toml`，执行 `chmod 600 profile.toml` 后填写。它保存明文凭据，已列入 Git 忽略规则。

- `username` 与 `password` 同时填写可用于自动登录，同时留空可复用会话或在可见浏览器中手动登录。
- `major`、`cohort`、`stream` 分别指定默认专业、四位整数入学年份和方向，均可省略。工作台只显示这三个字段。
- 查询学期在工作台或 API 请求中指定。浏览器通道、会话目录等选项写入 `browser.toml`。

## 刷新与排课

1. 填 SIS 学期代码，例如 `2620`。范围可选本机专业配置、指定专业与入学年份、所有专业。指定专业时可填「电子与计算机工程」、`2025`、`Computer Engineering`。首次试跑可把学科填为 `ECE`。
2. 点「刷新目录与修读记录」。目录按学科抓取，随后读取个人修读记录。需要人工认证时在 scraper 打开的学校窗口操作。页面显示当前阶段及学科进度，关闭页面后可重新连接查看任务。
3. 取消或失败时可继续浏览原目录。同条件再次刷新会使用 scraper 已保存的学科断点。若要重新读取已完成的学科，勾选忽略旧断点。目录与修读记录均成功后一起发布；重启服务可恢复上次快照。同学期刷新时保留仍存在的已选课程和班级锁定。
4. 也可以通过「导入目录」和「导入修读记录」选择 scraper 的 JSON，顺序不限。手动文件仅在当前页面读取。通过的课程按课号去重并默认隐藏，取消「隐藏已修」可选择重修。带逐课修读依据的目录支持按要求类别过滤并显示页码。
5. 点击课程加入排课，设置开放班、空闲日、时间范围、课间间隔或指定班级。讲课班依照 scraper 的 `tutorial_selection` 与辅导班配对，并核对日期、时间及课间。必选时从允许的班号中选一个；可选时也会生成不选辅导班的方案。其他教学组成各选一班。配对状态为 unknown 的讲课班会标注「讲辅配对待确认」。勾选「仅已核实讲辅配对」可过滤这些方案。可查看总方案数，输入编号直接跳转，点击色块查看教学班详情。

服务数据保存在 `.planner`。其中 `current.json` 包含个人修读记录，`work/` 保存抓取断点。相同数据目录一次运行一个规划器服务。

## 开发

界面、导入解析、同步控制和排课 Worker 的 TypeScript 源码位于 `frontend/`。更新后执行 `npm ci && npm run build` 生成随包分发的 JavaScript。Python 服务回归测试可运行：

```sh
uv run python -m unittest discover -s tests
```

目录中的 `enrollment_requirements` 会显示 SIS 原文。规划器用已通过课程核对先修，用已通过或本次所选课程核对同修及排除条件。能完整识别的课号、AND/OR 和括号表达式参与排课；明确不满足的条件会显示课程与原因。未导入修读记录或含成绩门槛等复杂文字时，相应条件标为待核实。空字符串表示 SIS 未列要求。要补齐旧目录，可重新实时刷新。

规划器支持 scraper 的第二版 JSON（`schema_version: 2`）。开课数据来自 `offerings`，按教学班的 `kind`、`component` 和讲课班的 `tutorial_selection` 排课。注册条件直接使用结构化的 `prerequisite`、`corequisite`、`exclusion` 以及嵌套的 `all_of`、`any_of`；自由文本保留供核对。仅接受当前版本的课程目录和修读记录。旧文件请重新导出，旧快照请通过刷新 SIS 替换。
