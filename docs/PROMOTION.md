# Balance Voice 推广文案

以下为可复制、按发布渠道调整的文案草稿。项目目前通过 Chrome 开发者模式加载源码，尚未提供应用商店安装入口。

## 仓库简介

> 一款在本机处理音频的 Chrome 扩展：自动统一常见网页音视频音量，提供响度均衡、单页静音/调音、实时电平和可设置的 dBFS 峰值上限。

英文版本：

> A local-first Chrome extension for consistent web audio: automatic leveling, per-tab volume and mute controls, live meters, and a configurable digital peak ceiling. No audio uploads.

## 社区 / 社交平台短介绍

### 标题

开源了一个 Chrome 调音小工具：切换网页，不用再反复调音量

### 正文

看课时嫌声音小，切到下一个视频又突然很响？我做了一个开源 Chrome 扩展 **Balance Voice**，把浏览器里的调音操作集中到一个面板。

- 普通网页音视频默认自动管理，不用逐页开启。
- 用一个百分比调节统一音量，也可以设置数字输出峰值上限。
- 按网页查看实时电平，直接静音、调高、调低，或恢复跟随统一音量。
- 自动平衡声音强弱；需要更严格的峰值限制时，可手动接管整页音频。
- 音频只在本机处理，无需账号，不录音、不上传。

项目采用 MIT 协议，欢迎试用、反馈播放器兼容性问题，或者一起改进。

项目地址：[github.com/tyrantqiao/balanceVoice](https://github.com/tyrantqiao/balanceVoice)

安装方法：下载源码 → 在 `chrome://extensions/` 开启开发者模式 → 加载项目的 `extension` 文件夹。无需构建。

说明：默认模式通过采样调整音量，突发峰值可能短暂超限；整页接管支持音频线程限幅。dBFS 是数字音频电平，不能换算成耳边声压或作为听力安全保证。

## 更短的分享版本

> 推荐给经常在浏览器看课、听歌、看直播的朋友：Balance Voice 可以自动统一常见网页音视频音量，还能按网页静音/调音、查看电平、设置数字峰值上限。音频留在本机，MIT 开源，加载源码即可使用。项目：https://github.com/tyrantqiao/balanceVoice

## 面向开发者的介绍

Balance Voice 是一个无第三方运行依赖的 Manifest V3 Chrome 扩展。默认模式通过隔离内容脚本管理 HTML 音视频，增强模式以 `tabCapture` + Offscreen Document + AudioWorklet 处理标签页完整音频，实现 RMS 自动增益、平滑和可配置峰值限制。项目包含后台生命周期、多框架汇总、设置边界与 DSP 测试，以及隔离 Chrome 下的集成验证脚本。

适合一起改进的方向：播放器兼容性、跨平台测试、操作交互、可访问性和多语言文档。当前能力与限制以 [README](../README.md) 和 [使用手册](USAGE.md) 为准。

## 配图

- 项目横幅：[banner.svg](assets/banner.svg)
- 真实界面截图：[popup-preview.png](assets/popup-preview.png)

分享时避免将「数字峰值限制」描述为「系统音量限制」或「听力保护保证」，也不要宣称所有网站都能无授权接管。
