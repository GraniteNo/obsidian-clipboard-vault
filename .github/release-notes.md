Clipboard Vault 1.5.0 是用于 Windows 桌面版 Obsidian 的剪切板归档插件。

## 更新内容

- 新增归档多选、全选本页、取消选择与「删除所选」，支持跨页勾选。
- 批量删除前显示所选条目、数量和涉及日期，确认后执行。
- 同一归档笔记中的所选记录统一删除，每个笔记只写入一次，并为剩余条目连续编号。
- 已被修改、移走或无法写入的记录会跳过并提示。图片附件默认保留，可选择将未被其他笔记引用的独有附件移到回收站。
- 切换关键词、日期或类型时清空选择；删除后更新所选状态。

## 安装

1. 下载下方的 `clipboard-vault-1.5.0-install.zip`，解压得到 `clipboard-vault` 文件夹。
2. 将该文件夹放入 Vault 的 `.obsidian/plugins/` 下。
3. 重启 Obsidian，在“设置 → 第三方插件”中启用 **Clipboard Vault**。

升级时覆盖旧版本的运行文件；请保留压缩包中的 `clipboard-helper.ps1`。

需要 Windows 桌面版 Obsidian 1.5.0 或更高版本。详细用法和兼容性说明见仓库 README。
