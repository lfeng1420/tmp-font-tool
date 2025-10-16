# 项目简介
[TextMeshPro](https://github.com/LeeYip/cocos-text-mesh-pro)字体工具。
原有的工具依赖[Hiero](https://libgdx.com/wiki/tools/hiero)导出，而Hiero无法设置offsetX/offsetY导致可能出现某些字体的文本无法居中的情况。因此对工具做了如下调整：
* 移除Hiero依赖，改为依赖[msdfgen工具](https://github.com/Chlumsky/msdfgen)（MacOS平台未测试，请自行验证）
* `源字体`/`导出目录`/`文本文件`改为`project://`项目路径，适用于多人开发场景（打开工具界面时仍然会显示`file://`，不确定是不是编辑器bug）
* 删除`scale`配置项，增加`X偏移`/`Y偏移`/`距离场宽度`/`智能尺寸`/`使用2的幂大小`/`使用正方形尺寸`
* 增加资源刷新按钮，在导出字符集后可刷新项目内的资源，同步纹理资源的修改

## 安装
```bash
# 安装依赖模块
npm install
# 构建
npm run build
```
