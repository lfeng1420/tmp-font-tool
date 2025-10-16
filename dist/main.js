"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.methods = void 0;
exports.load = load;
exports.unload = unload;
// @ts-ignore
const package_json_1 = __importDefault(require("../package.json"));
const lodash_1 = require("lodash");
const path_1 = __importDefault(require("path"));
const maxrects_packer_1 = require("maxrects-packer");
const bluebird_1 = require("bluebird");
const opentype_js_1 = require("opentype.js");
const child_process_1 = require("child_process");
const utils_1 = __importDefault(require("./utils"));
const jimp_1 = __importDefault(require("jimp"));
const { dialog } = require("electron");
const os = require("os");
const fs = require("fs");
const LOG_TAG = "[tmp-font-tool] ";
const MAX_TEXTURES_NUM = 4;
const PROJ_PREFIX = "project://";
const DB_PREFIX = "db://";
const CONFIG_PATH = `${__dirname}/config.json`;
const TEMP_PATH = `${__dirname}/temp`;
const BIN_PATH = `${__dirname}/../bin`;
const BIN_MAP = {
    "darwin": 'msdfgen.osx',
    "win32": 'msdfgen.exe',
};
let config = {
    fontPath: "",
    exportName: "",
    exportDir: "",
    /** 导出文本来源 0:输入框 1:txt文件 */
    textFrom: 0,
    textStr: "",
    textPath: "",
    fontSize: 32,
    padding: 0,
    offsetX: 0,
    offsetY: 0,
    distRange: 10,
    smartSize: true,
    pot: true,
    square: true,
    width: 1024,
    height: 1024
};
let progress = 0;
let charSetLen = 0;
let succNum = 0;
let failNum = 0;
function isFileExist(path) {
    return new Promise((resolve, reject) => {
        fs.access(path, fs.constants.F_OK, (err) => {
            resolve(!err);
        });
    });
}
async function readConfig() {
    try {
        let exist = await isFileExist(CONFIG_PATH);
        if (!exist) {
            return;
        }
        let data = fs.readFileSync(CONFIG_PATH, "utf-8");
        if (data) {
            config = JSON.parse(data);
        }
    }
    catch (err) {
        console.error(`${LOG_TAG}readConfig error ${err}`);
    }
}
function writeConfig() {
    try {
        let data = JSON.stringify(config);
        fs.writeFileSync(CONFIG_PATH, data);
        console.log(`${LOG_TAG}Write config: ${path_1.default.relative(Editor.Project.path, CONFIG_PATH)}`);
    }
    catch (err) {
        console.error(`${LOG_TAG}writeConfig error ${err}`);
    }
}
function handleCharset() {
    let charset;
    if (config.textFrom === 1) {
        const textPath = resolveProjPath(config.textPath);
        charset = fs.readFileSync(textPath, 'utf-8').split('');
    }
    else {
        charset = config.textStr.split('');
    }
    charset = (0, lodash_1.uniq)(charset);
    (0, lodash_1.remove)(charset, (o) => ['\n', '\r', '\t'].includes(o));
    return charset;
}
function resolveProjPath(tmpPath) {
    if (tmpPath.startsWith(PROJ_PREFIX)) {
        return path_1.default.join(Editor.Project.path, tmpPath.substring(PROJ_PREFIX.length));
    }
    return tmpPath;
}
async function generateGlyphImage(args) {
    const { binaryPath, minY1, font, char } = args;
    const glyph = font.charToGlyph(char);
    const contours = [];
    let currentContour = [];
    const gPath = glyph.getPath(0, 0, +config.fontSize);
    const pathCommands = gPath.commands;
    const bBox = gPath.getBoundingBox();
    pathCommands.forEach((command) => {
        currentContour.push(command);
        if (command.type === 'Z') { // end of contour
            contours.push(currentContour);
            currentContour = [];
        }
    });
    const shapeDesc = utils_1.default.getShapeDesc(contours);
    if (contours.some(cont => cont.length === 1)) {
        console.log('length is 1, failed to normalize glyph');
    }
    ;
    const scale = +config.fontSize / font.unitsPerEm;
    const pad = +config.distRange >> 1;
    let width = Math.round(bBox.x2 - bBox.x1) + pad + pad;
    let height = Math.round(bBox.y2 - bBox.y1) + pad + pad;
    let xOffset = Math.round(-bBox.x1) + pad;
    let yOffset = Math.round(-bBox.y1) + pad;
    const shapeDescPath = path_1.default.join(TEMP_PATH, `${char.charCodeAt(0)}.txt`);
    fs.writeFileSync(shapeDescPath, shapeDesc);
    const command = `"${binaryPath}" sdf -format text -stdout -size ${width} ${height} -translate ${xOffset} ${yOffset} -pxrange ${+config.distRange} -shapedesc "${shapeDescPath}"`;
    const result = await (0, bluebird_1.fromCallback)((callback) => {
        (0, child_process_1.exec)(command, { maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
            const container = {
                data: {
                    fontData: {
                        id: char.charCodeAt(0),
                        index: glyph.index,
                        char: char,
                        width: width,
                        height: height,
                        x: 0,
                        y: 0,
                        xoffset: Math.round(bBox.x1) + (+config.offsetX),
                        // 正数向下偏移, 负数向上偏移, 都是 0 的情况, 看起来是所有字符顶对齐, 所以只要让最靠下的字符 yoffset 值为 -pad, 就能在 Cocos 中, 看起来所有字符大致都在节点包围盒内
                        yoffset: Math.round(Math.abs(minY1) + bBox.y1 - pad) + (+config.offsetY),
                        xadvance: Math.round(glyph.advanceWidth * scale),
                        page: 0,
                        chnl: 15
                    }
                },
                width: width,
                height: height,
                x: 0,
                y: 0,
            };
            if (err) {
                console.error(err);
                callback(null, container);
                return;
            }
            // split on every number, parse from hex
            const rawImageData = stdout.match(/([0-9a-fA-F]+)/g).map(str => parseInt(str, 16));
            const pixels = [];
            const channelCount = rawImageData.length / width / height;
            if (!isNaN(channelCount) && channelCount % 1 !== 0) {
                console.error("msdfgen returned an image with an invalid length");
                callback(null, container);
                return;
            }
            if (channelCount === 3) {
                for (let i = 0; i < rawImageData.length; i += channelCount) {
                    pixels.push(...rawImageData.slice(i, i + channelCount), 255);
                }
            }
            else if (channelCount === 4) {
                for (let i = 0; i < rawImageData.length; i += channelCount) {
                    pixels.push(...rawImageData.slice(i, i + channelCount));
                }
            }
            else {
                for (let i = 0; i < rawImageData.length; i += channelCount) {
                    pixels.push(rawImageData[i], rawImageData[i], rawImageData[i], rawImageData[i]);
                }
            }
            let imageData = undefined;
            if (rawImageData.some(x => x !== 0) || char === ' ') { // if character is blank
                const buffer = new Uint8ClampedArray(pixels);
                imageData = new jimp_1.default({ data: buffer, width: width, height: height });
            }
            container.data.imageData = imageData;
            progress = ++succNum / Math.max(1, charSetLen);
            Editor.Message.send(package_json_1.default.name, "update-progress", progress, "");
            callback(null, container);
        });
    });
    if (fs.existsSync(shapeDescPath)) {
        fs.unlinkSync(shapeDescPath);
    }
    return result;
}
async function genBitmapFonts() {
    var _a, _b;
    const charset = handleCharset();
    const fontPath = config.fontPath;
    const font = (0, opentype_js_1.loadSync)(resolveProjPath(fontPath));
    const packer = new maxrects_packer_1.MaxRectsPacker(+config.width, +config.height, +config.padding, {
        smart: config.smartSize,
        pot: config.pot,
        square: config.square
    });
    const rects = charset.map((char) => {
        const glyph = font.charToGlyph(char);
        const boundingBox = glyph.getPath(0, 0, +config.fontSize).getBoundingBox();
        const pad = +config.distRange >> 1;
        return {
            width: Math.round(boundingBox.x2 - boundingBox.x1) + pad * 2,
            height: Math.round(boundingBox.y2 - boundingBox.y1) + pad * 2,
        };
    });
    packer.addArray(rects);
    packer.reset();
    charSetLen = charset.length;
    const limit = ((_b = (_a = os.cpus) === null || _a === void 0 ? void 0 : _a.call(os)) === null || _b === void 0 ? void 0 : _b.length) || 4;
    // 用这几个显示上最靠下的字符 (有低于基线的部分), 作为计算 yoffset 基准值
    const paths = font.getPaths("gjpqy", 0, 0, +config.fontSize);
    const bBoxs = paths.map((o) => o.getBoundingBox());
    const minY1 = (0, lodash_1.minBy)(bBoxs, (o) => o.y1).y1;
    const results = await (0, bluebird_1.map)(charset, (char) => generateGlyphImage({
        binaryPath: path_1.default.join(BIN_PATH, process.platform, BIN_MAP[process.platform]),
        minY1,
        font: font,
        char: char
    }), { concurrency: limit });
    const failedCharSet = (0, lodash_1.remove)(results, (o) => (0, lodash_1.isNil)(o.data.imageData)).map((o) => [o.data.fontData.id, o.data.fontData.char]);
    if (failedCharSet.length > 0) {
        console.log(`${LOG_TAG}Failed chars:${JSON.stringify(failedCharSet)}`);
        failNum = failedCharSet.length;
    }
    if (results.length <= 0) {
        throw new Error("No successfully generated characters");
    }
    packer.addArray(results);
    const succChars = [];
    const pages = [];
    const textures = await (0, bluebird_1.map)(packer.bins, async (bin, index) => {
        const fillColor = 0x00000000;
        let fontImg = new jimp_1.default(bin.width, bin.height, fillColor);
        const textureName = `${config.exportName}_${index}.png`;
        pages.push({ id: pages.length, file: path_1.default.basename(textureName) });
        bin.rects.forEach((rect) => {
            fontImg.composite(rect.data.imageData, rect.x, rect.y);
            const charData = rect.data.fontData;
            charData.x = rect.x;
            charData.y = rect.y;
            charData.page = index;
            succChars.push(rect.data.fontData);
        });
        const buffer = await fontImg.getBufferAsync(jimp_1.default.MIME_PNG);
        return { filename: textureName, texture: buffer };
    });
    const scale = +config.fontSize / font.unitsPerEm;
    const baseline = (font.ascender + font.descender) * scale + ((+config.distRange) >> 1);
    const fontData = {
        size: +config.fontSize,
        bold: 0,
        italic: 0,
        padding: Array(4).fill(+config.padding).join(','),
        spacing: "",
        outline: 0,
        lineHeight: Math.round((font.ascender - font.descender) * scale + (+config.distRange)),
        base: Math.round(baseline),
        scaleW: packer.bins[0].width,
        scaleH: packer.bins[0].height,
        pages: packer.bins.length,
        packed: 0,
        alphaChnl: 0,
        redChnl: 0,
        greenChnl: 0,
        blueChnl: 0,
        smooth: 1,
        pageData: pages,
        charData: succChars
    };
    return { textures, fontData };
}
async function delUnusedTextures(outPath, len) {
    if (len >= MAX_TEXTURES_NUM) {
        return;
    }
    try {
        for (let index = len; index <= MAX_TEXTURES_NUM; ++index) {
            const finalPath = path_1.default.join(outPath, `${config.exportName}_${index}.png`);
            console.log(`${LOG_TAG}Delete asset ${finalPath}`);
            await Editor.Message.request('asset-db', 'delete-asset', finalPath);
        }
    }
    catch (err) {
    }
    ;
}
async function exportFont() {
    try {
        let check = fs.existsSync(`${TEMP_PATH}`);
        if (!check) {
            fs.mkdirSync(`${TEMP_PATH}`);
        }
        progress = 0;
        charSetLen = 0;
        succNum = 0;
        failNum = 0;
        const outPath = resolveProjPath(config.exportDir);
        const { textures, fontData } = await genBitmapFonts();
        Editor.Message.send(package_json_1.default.name, "update-progress", succNum / Math.max(1, charSetLen), "Writing textures...");
        textures.forEach((texture, index) => {
            const pngPath = path_1.default.join(outPath, texture.filename);
            fs.writeFile(pngPath, texture.texture, (err) => {
                if (err) {
                    console.log(`${LOG_TAG}Write png ${index} FAIL: ${pngPath} ${err}`);
                }
                else {
                    console.log(`${LOG_TAG}Write png ${index} succ: ${pngPath}`);
                }
            });
        });
        // 删除多余的图片
        delUnusedTextures(outPath, textures.length);
        // 写入json
        Editor.Message.send(package_json_1.default.name, "update-progress", succNum / Math.max(1, charSetLen), "Writing json...");
        const jsonPath = path_1.default.join(outPath, `${config.exportName}.json`);
        fs.writeFile(jsonPath, JSON.stringify(fontData), (err) => {
            if (err) {
                console.log(`${LOG_TAG}Write json FAIL: ${jsonPath} ${err}`);
            }
            else {
                console.log(`${LOG_TAG}Write json succ: ${jsonPath}`);
            }
        });
        // 刷新资源
        const tips = (failNum <= 0) ? "SUCCESS" : `DONE! fail:${failNum}`;
        Editor.Message.send(package_json_1.default.name, "update-progress", succNum / Math.max(1, charSetLen), tips);
        if (config.exportDir.startsWith(PROJ_PREFIX)) {
            const exportDir = config.exportDir.replace(PROJ_PREFIX, DB_PREFIX);
            await Editor.Message.request("asset-db", "refresh-asset", exportDir);
            console.log(`${LOG_TAG}Refresh asset for ${exportDir} done.`);
        }
    }
    catch (err) {
        console.error(`${LOG_TAG}exportFont error ${err}`);
    }
}
async function buildUpdatedTextures(outPath, jsonPath) {
    // 获取json引用的图片资源
    const textureNames = utils_1.default.parseTextures(jsonPath);
    if (!textureNames || textureNames.length <= 0) {
        console.error(`${LOG_TAG}parseTextures of ${jsonPath} fail!`);
        return undefined;
    }
    const uuidGetFunc = (meta) => {
        if (!meta.subMetas || Object.keys(meta.subMetas).length === 0) {
            return meta.uuid; // 没有子级时使用主UUID
        }
        // 有子级时使用第一个（或根据业务逻辑选择）
        const firstSub = Object.values(meta.subMetas)[0];
        return (firstSub === null || firstSub === void 0 ? void 0 : firstSub.uuid) || meta.uuid;
    };
    // 查询图片资源uuid，构造ICompTexture
    const textures = [];
    for (const textureName of textureNames) {
        const pngPath = path_1.default.join(outPath, textureName);
        const meta = await Editor.Message.request('asset-db', 'query-asset-meta', pngPath);
        const uuid = uuidGetFunc(meta);
        if (!uuid) {
            console.error(`${LOG_TAG}Query uuid of ${textureName} fail!`);
            return undefined;
        }
        textures.push({ __uuid__: uuid, __expectedType__: "cc.Texture2D" });
        console.log(`${LOG_TAG}${path_1.default.relative(Editor.Project.path, pngPath)}: ${uuid}`);
    }
    return textures;
}
function updateAsset(filePath, jsonUuid, textures) {
    try {
        const data = fs.readFileSync(filePath, 'utf-8');
        const array = JSON.parse(data);
        const updated = array.map(obj => {
            var _a;
            if ((((_a = obj._font) === null || _a === void 0 ? void 0 : _a.__uuid__) === jsonUuid) && !utils_1.default.checkTexturesMatch(obj.textures, textures)) {
                return Object.assign(Object.assign({}, obj), { textures: [...textures] });
            }
            return obj;
        });
        fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
        return true;
    }
    catch (err) {
        console.error(`${LOG_TAG}updateAsset error ${err}`);
        return false;
    }
}
async function syncRes() {
    try {
        // 获取json文件uuid
        const outPath = resolveProjPath(config.exportDir);
        const jsonPath = path_1.default.join(outPath, `${config.exportName}.json`);
        const jsonUuid = await Editor.Message.request('asset-db', 'query-uuid', jsonPath);
        if (!jsonUuid) {
            console.error(`${LOG_TAG}Query uuid of ${jsonPath} fail!`);
            return;
        }
        // 查询所有用到的资源
        console.log(`${LOG_TAG}jsonUuid:${jsonUuid}`);
        const users = await Editor.Message.request('asset-db', 'query-asset-users', jsonUuid);
        if (!users) {
            console.log(`${LOG_TAG}No users of ${jsonPath}, nothing to do.`);
            return;
        }
        let textures;
        for (let index = 0; index < users.length; ++index) {
            const uuid = users[index];
            const assetInfo = await Editor.Message.request('asset-db', 'query-asset-info', uuid);
            if (!assetInfo) {
                console.warn(`${LOG_TAG}Query asset of ${uuid} fail!`);
                continue;
            }
            // 生成要替换的textures内容
            if (!textures) {
                textures = await buildUpdatedTextures(outPath, jsonPath);
                if (!textures) {
                    console.error(`${LOG_TAG}buildUpdatedTextures fail! json:${jsonPath}`);
                    return;
                }
            }
            // 更新
            const succ = await updateAsset(assetInfo.file, jsonUuid, textures);
            console.log(`${LOG_TAG}${index + 1}/${users.length} ${assetInfo.url} ${succ ? "SUCC" : "FAIL"}`);
            if (succ) {
                await Editor.Message.request('asset-db', 'reimport-asset', assetInfo.uuid);
            }
        }
    }
    catch (err) {
        console.error(`${LOG_TAG}Sync res fail! ${err}`);
        return;
    }
}
/**
 * @en
 * @zh 为扩展的主进程的注册方法
 */
exports.methods = {
    openPanel() {
        Editor.Panel.open(package_json_1.default.name);
    },
    onPanelInit() {
        Editor.Message.send(package_json_1.default.name, "refresh-config", config);
    },
    onChangeConfig(key, value) {
        config[key] = value;
    },
    onClickBtnSync() {
        syncRes();
    },
    onClickBtnSave(arg) {
        if (arg) {
            config = arg;
        }
        writeConfig();
    },
    onClickBtnExport() {
        exportFont();
    }
};
/**
 * @en Hooks triggered after extension loading is complete
 * @zh 扩展加载完成后触发的钩子
 */
function load() {
    readConfig();
}
/**
 * @en Hooks triggered after extension uninstallation is complete
 * @zh 扩展卸载完成后触发的钩子
 */
function unload() { }
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9tYWluLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7OztBQXVnQkEsb0JBRUM7QUFNRCx3QkFBNEI7QUEvZ0I1QixhQUFhO0FBQ2IsbUVBQTBDO0FBQzFDLG1DQUFvRDtBQUNwRCxnREFBd0I7QUFDeEIscURBQWlEO0FBQ2pELHVDQUE0RDtBQUM1RCw2Q0FBMEQ7QUFFMUQsaURBQXFDO0FBQ3JDLG9EQUE0QjtBQUM1QixnREFBd0I7QUFHeEIsTUFBTSxFQUFFLE1BQU0sRUFBRSxHQUFHLE9BQU8sQ0FBQyxVQUFVLENBQUMsQ0FBQztBQUN2QyxNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDekIsTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBRXpCLE1BQU0sT0FBTyxHQUFHLGtCQUFrQixDQUFDO0FBQ25DLE1BQU0sZ0JBQWdCLEdBQUcsQ0FBQyxDQUFDO0FBQzNCLE1BQU0sV0FBVyxHQUFHLFlBQVksQ0FBQztBQUNqQyxNQUFNLFNBQVMsR0FBRyxPQUFPLENBQUM7QUFDMUIsTUFBTSxXQUFXLEdBQUcsR0FBRyxTQUFTLGNBQWMsQ0FBQztBQUMvQyxNQUFNLFNBQVMsR0FBRyxHQUFHLFNBQVMsT0FBTyxDQUFDO0FBQ3RDLE1BQU0sUUFBUSxHQUFHLEdBQUcsU0FBUyxTQUFTLENBQUM7QUFDdkMsTUFBTSxPQUFPLEdBQTJCO0lBQ3BDLFFBQVEsRUFBRSxhQUFhO0lBQ3ZCLE9BQU8sRUFBRSxhQUFhO0NBQ3pCLENBQUM7QUFFRixJQUFJLE1BQU0sR0FBaUQ7SUFDdkQsUUFBUSxFQUFFLEVBQUU7SUFFWixVQUFVLEVBQUUsRUFBRTtJQUNkLFNBQVMsRUFBRSxFQUFFO0lBRWIsMkJBQTJCO0lBQzNCLFFBQVEsRUFBRSxDQUFDO0lBQ1gsT0FBTyxFQUFFLEVBQUU7SUFDWCxRQUFRLEVBQUUsRUFBRTtJQUVaLFFBQVEsRUFB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QUFDO0lBQ2xCLENBQUM7SUFFRCxnQkFBZ0I7UUFDWixVQUFVLEVBQUUsQ0FBQztJQUNqQixDQUFDO0NBQ0osQ0FBQztBQUVGOzs7R0FHRztBQUNILFNBQWdCLElBQUk7SUFDaEIsVUFBVSxFQUFFLENBQUM7QUFDakIsQ0FBQztBQUVEOzs7R0FHRztBQUNILFNBQWdCLE1BQU0sS0FBSyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLy8gQHRzLWlnbm9yZVxuaW1wb3J0IHBhY2thZ2VKU09OIGZyb20gJy4uL3BhY2thZ2UuanNvbic7XG5pbXBvcnQgeyByZW1vdmUsIHVuaXEsIG1pbkJ5LCBpc05pbCB9IGZyb20gJ2xvZGFzaCc7XG5pbXBvcnQgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCB7IE1heFJlY3RzUGFja2VyIH0gZnJvbSAnbWF4cmVjdHMtcGFja2VyJztcbmltcG9ydCB7IGZyb21DYWxsYmFjaywgbWFwIGFzIGJsdWVCaXJkTWFwIH0gZnJvbSAnYmx1ZWJpcmQnO1xuaW1wb3J0IHsgRm9udCwgbG9hZFN5bmMsIFBhdGhDb21tYW5kIH0gZnJvbSAnb3BlbnR5cGUuanMnO1xuaW1wb3J0IHsgSUNvbXAsIElDb21wVGV4dHVyZSwgSUNvbnRhaW5lciwgSUZudENvbmZpZywgSUZvbnREYXRhLCBJUGFnZURhdGEgfSBmcm9tICcuL2ludGVyZmFjZSc7XG5pbXBvcnQgeyBleGVjIH0gZnJvbSAnY2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQgVXRpbHMgZnJvbSAnLi91dGlscyc7XG5pbXBvcnQgSmltcCBmcm9tICdqaW1wJztcbmltcG9ydCB7IHBpcGVsaW5lIH0gZnJvbSAnc3RyZWFtJztcblxuY29uc3QgeyBkaWFsb2cgfSA9IHJlcXVpcmUoXCJlbGVjdHJvblwiKTtcbmNvbnN0IG9zID0gcmVxdWlyZShcIm9zXCIpO1xuY29uc3QgZnMgPSByZXF1aXJlKFwiZnNcIik7XG5cbmNvbnN0IExPR19UQUcgPSBcIlt0bXAtZm9udC10b29sXSBcIjtcbmNvbnN0IE1BWF9URVhUVVJFU19OVU0gPSA0O1xuY29uc3QgUFJPSl9QUkVGSVggPSBcInByb2plY3Q6Ly9cIjtcbmNvbnN0IERCX1BSRUZJWCA9IFwiZGI6Ly9cIjtcbmNvbnN0IENPTkZJR19QQVRIID0gYCR7X19kaXJuYW1lfS9jb25maWcuanNvbmA7XG5jb25zdCBURU1QX1BBVEggPSBgJHtfX2Rpcm5hbWV9L3RlbXBgO1xuY29uc3QgQklOX1BBVEggPSBgJHtfX2Rpcm5hbWV9Ly4uL2JpbmA7XG5jb25zdCBCSU5fTUFQOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgIFwiZGFyd2luXCI6ICdtc2RmZ2VuLm9zeCcsXG4gICAgXCJ3aW4zMlwiOiAnbXNkZmdlbi5leGUnLFxufTtcblxubGV0IGNvbmZpZzogeyBba2V5OiBzdHJpbmddOiBudW1iZXIgfCBzdHJpbmcgfCBib29sZWFuIH0gPSB7XG4gICAgZm9udFBhdGg6IFwiXCIsXG5cbiAgICBleHBvcnROYW1lOiBcIlwiLFxuICAgIGV4cG9ydERpcjogXCJcIixcblxuICAgIC8qKiDlr7zlh7rmlofmnKzmnaXmupAgMDrovpPlhaXmoYYgMTp0eHTmlofku7YgKi9cbiAgICB0ZXh0RnJvbTogMCxcbiAgICB0ZXh0U3RyOiBcIlwiLFxuICAgIHRleHRQYXRoOiBcIlwiLFxuXG4gICAgZm9udFNpemU6IDMyLFxuICAgIHBhZGRpbmc6IDAsXG4gICAgb2Zmc2V0WDogMCxcbiAgICBvZmZzZXRZOiAwLFxuICAgIGRpc3RSYW5nZTogMTAsXG4gICAgc21hcnRTaXplOiB0cnVlLFxuICAgIHBvdDogdHJ1ZSxcbiAgICBzcXVhcmU6IHRydWUsXG4gICAgd2lkdGg6IDEwMjQsXG4gICAgaGVpZ2h0OiAxMDI0XG59O1xubGV0IHByb2dyZXNzID0gMDtcbmxldCBjaGFyU2V0TGVuID0gMDtcbmxldCBzdWNjTnVtID0gMDtcbmxldCBmYWlsTnVtID0gMDtcblxuZnVuY3Rpb24gaXNGaWxlRXhpc3QocGF0aDogc3RyaW5nKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgZnMuYWNjZXNzKHBhdGgsIGZzLmNvbnN0YW50cy5GX09LLCAoZXJyOiBhbnkpID0+IHtcbiAgICAgICAgICAgIHJlc29sdmUoIWVycik7XG4gICAgICAgIH0pO1xuICAgIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWFkQ29uZmlnKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGxldCBleGlzdCA9IGF3YWl0IGlzRmlsZUV4aXN0KENPTkZJR19QQVRIKTtcbiAgICAgICAgaWYgKCFleGlzdCkge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGxldCBkYXRhID0gZnMucmVhZEZpbGVTeW5jKENPTkZJR19QQVRILCBcInV0Zi04XCIpO1xuICAgICAgICBpZiAoZGF0YSkge1xuICAgICAgICAgICAgY29uZmlnID0gSlNPTi5wYXJzZShkYXRhKTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zb2xlLmVycm9yKGAke0xPR19UQUd9cmVhZENvbmZpZyBlcnJvciAke2Vycn1gKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHdyaXRlQ29uZmlnKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGxldCBkYXRhID0gSlNPTi5zdHJpbmdpZnkoY29uZmlnKTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhDT05GSUdfUEFUSCwgZGF0YSk7XG4gICAgICAgIGNvbnNvbGUubG9nKGAke0xPR19UQUd9V3JpdGUgY29uZmlnOiAke3BhdGgucmVsYXRpdmUoRWRpdG9yLlByb2plY3QucGF0aCwgQ09ORklHX1BBVEgpfWApO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zb2xlLmVycm9yKGAke0xPR19UQUd9d3JpdGVDb25maWcgZXJyb3IgJHtlcnJ9YCk7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBoYW5kbGVDaGFyc2V0KCkge1xuICAgIGxldCBjaGFyc2V0OiBzdHJpbmdbXTtcbiAgICBpZiAoY29uZmlnLnRleHRGcm9tID09PSAxKSB7XG4gICAgICAgIGNvbnN0IHRleHRQYXRoID0gcmVzb2x2ZVByb2pQYXRoKGNvbmZpZy50ZXh0UGF0aCBhcyBzdHJpbmcpO1xuICAgICAgICBjaGFyc2V0ID0gZnMucmVhZEZpbGVTeW5jKHRleHRQYXRoLCAndXRmLTgnKS5zcGxpdCgnJyk7XG4gICAgfVxuICAgIGVsc2Uge1xuICAgICAgICBjaGFyc2V0ID0gKGNvbmZpZy50ZXh0U3RyIGFzIHN0cmluZykuc3BsaXQoJycpO1xuICAgIH1cbiAgICBjaGFyc2V0ID0gdW5pcShjaGFyc2V0KTtcbiAgICByZW1vdmUoY2hhcnNldCwgKG8pID0+IFsnXFxuJywgJ1xccicsICdcXHQnXS5pbmNsdWRlcyhvKSk7XG5cbiAgICByZXR1cm4gY2hhcnNldDtcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVByb2pQYXRoKHRtcFBhdGg6IHN0cmluZykge1xuICAgIGlmICh0bXBQYXRoLnN0YXJ0c1dpdGgoUFJPSl9QUkVGSVgpKSB7XG4gICAgICAgIHJldHVybiBwYXRoLmpvaW4oRWRpdG9yLlByb2plY3QucGF0aCwgdG1wUGF0aC5zdWJzdHJpbmcoUFJPSl9QUkVGSVgubGVuZ3RoKSk7XG4gICAgfVxuICAgIHJldHVybiB0bXBQYXRoO1xufVxuXG5cbmFzeW5jIGZ1bmN0aW9uIGdlbmVyYXRlR2x5cGhJbWFnZShhcmdzOiBhbnkpIHtcbiAgICBjb25zdCB7IGJpbmFyeVBhdGgsIG1pblkxLCBmb250LCBjaGFyIH0gPSBhcmdzO1xuICAgIGNvbnN0IGdseXBoID0gZm9udC5jaGFyVG9HbHlwaChjaGFyKTtcbiAgICBjb25zdCBjb250b3VyczogUGF0aENvbW1hbmRbXVtdID0gW107XG4gICAgbGV0IGN1cnJlbnRDb250b3VyOiBQYXRoQ29tbWFuZFtdID0gW107XG5cbiAgICBjb25zdCBnUGF0aCA9IGdseXBoLmdldFBhdGgoMCwgMCwgK2NvbmZpZy5mb250U2l6ZSk7XG4gICAgY29uc3QgcGF0aENvbW1hbmRzID0gZ1BhdGguY29tbWFuZHM7XG4gICAgY29uc3QgYkJveCA9IGdQYXRoLmdldEJvdW5kaW5nQm94KCk7XG4gICAgcGF0aENvbW1hbmRzLmZvckVhY2goKGNvbW1hbmQ6IFBhdGhDb21tYW5kKSA9PiB7XG4gICAgICAgIGN1cnJlbnRDb250b3VyLnB1c2goY29tbWFuZCk7XG4gICAgICAgIGlmIChjb21tYW5kLnR5cGUgPT09ICdaJykgeyAvLyBlbmQgb2YgY29udG91clxuICAgICAgICAgICAgY29udG91cnMucHVzaChjdXJyZW50Q29udG91cik7XG4gICAgICAgICAgICBjdXJyZW50Q29udG91ciA9IFtdO1xuICAgICAgICB9XG4gICAgfSk7XG4gICAgY29uc3Qgc2hhcGVEZXNjID0gVXRpbHMuZ2V0U2hhcGVEZXNjKGNvbnRvdXJzKTtcbiAgICBpZiAoY29udG91cnMuc29tZShjb250ID0+IGNvbnQubGVuZ3RoID09PSAxKSkge1xuICAgICAgICBjb25zb2xlLmxvZygnbGVuZ3RoIGlzIDEsIGZhaWxlZCB0byBub3JtYWxpemUgZ2x5cGgnKTtcbiAgICB9O1xuXG4gICAgY29uc3Qgc2NhbGUgPSArY29uZmlnLmZvbnRTaXplIC8gZm9udC51bml0c1BlckVtO1xuICAgIGNvbnN0IHBhZCA9ICtjb25maWcuZGlzdFJhbmdlID4+IDE7XG4gICAgbGV0IHdpZHRoID0gTWF0aC5yb3VuZChiQm94LngyIC0gYkJveC54MSkgKyBwYWQgKyBwYWQ7XG4gICAgbGV0IGhlaWdodCA9IE1hdGgucm91bmQoYkJveC55MiAtIGJCb3gueTEpICsgcGFkICsgcGFkO1xuICAgIGxldCB4T2Zmc2V0ID0gTWF0aC5yb3VuZCgtYkJveC54MSkgKyBwYWQ7XG4gICAgbGV0IHlPZmZzZXQgPSBNYXRoLnJvdW5kKC1iQm94LnkxKSArIHBhZDtcbiAgICBjb25zdCBzaGFwZURlc2NQYXRoID0gcGF0aC5qb2luKFRFTVBfUEFUSCwgYCR7Y2hhci5jaGFyQ29kZUF0KDApfS50eHRgKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKHNoYXBlRGVzY1BhdGgsIHNoYXBlRGVzYyk7XG4gICAgY29uc3QgY29tbWFuZCA9IGBcIiR7YmluYXJ5UGF0aH1cIiBzZGYgLWZvcm1hdCB0ZXh0IC1zdGRvdXQgLXNpemUgJHt3aWR0aH0gJHtoZWlnaHR9IC10cmFuc2xhdGUgJHt4T2Zmc2V0fSAke3lPZmZzZXR9IC1weHJhbmdlICR7K2NvbmZpZy5kaXN0UmFuZ2V9IC1zaGFwZWRlc2MgXCIke3NoYXBlRGVzY1BhdGh9XCJgO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGZyb21DYWxsYmFjaygoY2FsbGJhY2spID0+IHtcbiAgICAgICAgZXhlYyhjb21tYW5kLCB7IG1heEJ1ZmZlcjogMTAyNCAqIDEwMjQgKiA1IH0sIChlcnIsIHN0ZG91dCwgc3RkZXJyKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBjb250YWluZXI6IElDb250YWluZXIgPSB7XG4gICAgICAgICAgICAgICAgZGF0YToge1xuICAgICAgICAgICAgICAgICAgICBmb250RGF0YToge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWQ6IGNoYXIuY2hhckNvZGVBdCgwKSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGluZGV4OiBnbHlwaC5pbmRleCxcbiAgICAgICAgICAgICAgICAgICAgICAgIGNoYXI6IGNoYXIsXG4gICAgICAgICAgICAgICAgICAgICAgICB3aWR0aDogd2lkdGgsXG4gICAgICAgICAgICAgICAgICAgICAgICBoZWlnaHQ6IGhlaWdodCxcbiAgICAgICAgICAgICAgICAgICAgICAgIHg6IDAsXG4gICAgICAgICAgICAgICAgICAgICAgICB5OiAwLFxuICAgICAgICAgICAgICAgICAgICAgICAgeG9mZnNldDogTWF0aC5yb3VuZChiQm94LngxKSArICgrY29uZmlnLm9mZnNldFgpLFxuICAgICAgICAgICAgICAgICAgICAgICAgLy8g5q2j5pWw5ZCR5LiL5YGP56e7LCDotJ/mlbDlkJHkuIrlgY/np7ssIOmDveaYryAwIOeahOaDheWGtSwg55yL6LW35p2l5piv5omA5pyJ5a2X56ym6aG25a+56b2QLCDmiYDku6Xlj6ropoHorqnmnIDpnaDkuIvnmoTlrZfnrKYgeW9mZnNldCDlgLzkuLogLXBhZCwg5bCx6IO95ZyoIENvY29zIOS4rSwg55yL6LW35p2l5omA5pyJ5a2X56ym5aSn6Ie06YO95Zyo6IqC54K55YyF5Zu055uS5YaFXG4gICAgICAgICAgICAgICAgICAgICAgICB5b2Zmc2V0OiBNYXRoLnJvdW5kKE1hdGguYWJzKG1pblkxKSArIGJCb3gueTEgLSBwYWQpICsgKCtjb25maWcub2Zmc2V0WSksXG4gICAgICAgICAgICAgICAgICAgICAgICB4YWR2YW5jZTogTWF0aC5yb3VuZChnbHlwaC5hZHZhbmNlV2lkdGggKiBzY2FsZSksXG4gICAgICAgICAgICAgICAgICAgICAgICBwYWdlOiAwLFxuICAgICAgICAgICAgICAgICAgICAgICAgY2hubDogMTVcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgd2lkdGg6IHdpZHRoLFxuICAgICAgICAgICAgICAgIGhlaWdodDogaGVpZ2h0LFxuICAgICAgICAgICAgICAgIHg6IDAsXG4gICAgICAgICAgICAgICAgeTogMCxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcihlcnIpO1xuICAgICAgICAgICAgICAgIGNhbGxiYWNrKG51bGwsIGNvbnRhaW5lcik7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gc3BsaXQgb24gZXZlcnkgbnVtYmVyLCBwYXJzZSBmcm9tIGhleFxuICAgICAgICAgICAgY29uc3QgcmF3SW1hZ2VEYXRhID0gc3Rkb3V0Lm1hdGNoKC8oWzAtOWEtZkEtRl0rKS9nKSEubWFwKHN0ciA9PiBwYXJzZUludChzdHIsIDE2KSk7XG4gICAgICAgICAgICBjb25zdCBwaXhlbHMgPSBbXTtcbiAgICAgICAgICAgIGNvbnN0IGNoYW5uZWxDb3VudCA9IHJhd0ltYWdlRGF0YS5sZW5ndGggLyB3aWR0aCAvIGhlaWdodDtcblxuICAgICAgICAgICAgaWYgKCFpc05hTihjaGFubmVsQ291bnQpICYmIGNoYW5uZWxDb3VudCAlIDEgIT09IDApIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmVycm9yKFwibXNkZmdlbiByZXR1cm5lZCBhbiBpbWFnZSB3aXRoIGFuIGludmFsaWQgbGVuZ3RoXCIpO1xuICAgICAgICAgICAgICAgIGNhbGxiYWNrKG51bGwsIGNvbnRhaW5lcik7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGNoYW5uZWxDb3VudCA9PT0gMykge1xuICAgICAgICAgICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcmF3SW1hZ2VEYXRhLmxlbmd0aDsgaSArPSBjaGFubmVsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgcGl4ZWxzLnB1c2goLi4ucmF3SW1hZ2VEYXRhLnNsaWNlKGksIGkgKyBjaGFubmVsQ291bnQpLCAyNTUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoY2hhbm5lbENvdW50ID09PSA0KSB7XG4gICAgICAgICAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCByYXdJbWFnZURhdGEubGVuZ3RoOyBpICs9IGNoYW5uZWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICBwaXhlbHMucHVzaCguLi5yYXdJbWFnZURhdGEuc2xpY2UoaSwgaSArIGNoYW5uZWxDb3VudCkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCByYXdJbWFnZURhdGEubGVuZ3RoOyBpICs9IGNoYW5uZWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICBwaXhlbHMucHVzaChyYXdJbWFnZURhdGFbaV0sIHJhd0ltYWdlRGF0YVtpXSwgcmF3SW1hZ2VEYXRhW2ldLCByYXdJbWFnZURhdGFbaV0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGxldCBpbWFnZURhdGEgPSB1bmRlZmluZWQ7XG4gICAgICAgICAgICBpZiAocmF3SW1hZ2VEYXRhLnNvbWUoeCA9PiB4ICE9PSAwKSB8fCBjaGFyID09PSAnICcpIHsgLy8gaWYgY2hhcmFjdGVyIGlzIGJsYW5rXG4gICAgICAgICAgICAgICAgY29uc3QgYnVmZmVyID0gbmV3IFVpbnQ4Q2xhbXBlZEFycmF5KHBpeGVscyk7XG4gICAgICAgICAgICAgICAgaW1hZ2VEYXRhID0gbmV3IEppbXAoeyBkYXRhOiBidWZmZXIsIHdpZHRoOiB3aWR0aCwgaGVpZ2h0OiBoZWlnaHQgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb250YWluZXIuZGF0YS5pbWFnZURhdGEgPSBpbWFnZURhdGE7XG5cbiAgICAgICAgICAgIHByb2dyZXNzID0gKytzdWNjTnVtIC8gTWF0aC5tYXgoMSwgY2hhclNldExlbik7XG4gICAgICAgICAgICBFZGl0b3IuTWVzc2FnZS5zZW5kKHBhY2thZ2VKU09OLm5hbWUsIFwidXBkYXRlLXByb2dyZXNzXCIsIHByb2dyZXNzLCBcIlwiKTtcbiAgICAgICAgICAgIGNhbGxiYWNrKG51bGwsIGNvbnRhaW5lcik7XG4gICAgICAgIH0pO1xuICAgIH0pO1xuICAgIGlmIChmcy5leGlzdHNTeW5jKHNoYXBlRGVzY1BhdGgpKSB7XG4gICAgICAgIGZzLnVubGlua1N5bmMoc2hhcGVEZXNjUGF0aCk7XG4gICAgfVxuICAgIHJldHVybiByZXN1bHQgYXMgSUNvbnRhaW5lcjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2VuQml0bWFwRm9udHMoKSB7XG4gICAgY29uc3QgY2hhcnNldCA9IGhhbmRsZUNoYXJzZXQoKTtcbiAgICBjb25zdCBmb250UGF0aCA9IGNvbmZpZy5mb250UGF0aCBhcyBzdHJpbmc7XG4gICAgY29uc3QgZm9udCA9IGxvYWRTeW5jKHJlc29sdmVQcm9qUGF0aChmb250UGF0aCkpO1xuICAgIGNvbnN0IHBhY2tlciA9IG5ldyBNYXhSZWN0c1BhY2tlcigrY29uZmlnLndpZHRoLCArY29uZmlnLmhlaWdodCwgK2NvbmZpZy5wYWRkaW5nLCB7XG4gICAgICAgIHNtYXJ0OiBjb25maWcuc21hcnRTaXplIGFzIGJvb2xlYW4sXG4gICAgICAgIHBvdDogY29uZmlnLnBvdCBhcyBib29sZWFuLFxuICAgICAgICBzcXVhcmU6IGNvbmZpZy5zcXVhcmUgYXMgYm9vbGVhblxuICAgIH0pO1xuICAgIGNvbnN0IHJlY3RzID0gY2hhcnNldC5tYXAoKGNoYXIpID0+IHtcbiAgICAgICAgY29uc3QgZ2x5cGggPSBmb250LmNoYXJUb0dseXBoKGNoYXIpO1xuICAgICAgICBjb25zdCBib3VuZGluZ0JveCA9IGdseXBoLmdldFBhdGgoMCwgMCwgK2NvbmZpZy5mb250U2l6ZSkuZ2V0Qm91bmRpbmdCb3goKTtcbiAgICAgICAgY29uc3QgcGFkID0gK2NvbmZpZy5kaXN0UmFuZ2UgPj4gMTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHdpZHRoOiBNYXRoLnJvdW5kKGJvdW5kaW5nQm94LngyIC0gYm91bmRpbmdCb3gueDEpICsgcGFkICogMixcbiAgICAgICAgICAgIGhlaWdodDogTWF0aC5yb3VuZChib3VuZGluZ0JveC55MiAtIGJvdW5kaW5nQm94LnkxKSArIHBhZCAqIDIsXG4gICAgICAgIH07XG4gICAgfSk7XG4gICAgcGFja2VyLmFkZEFycmF5KHJlY3RzIGFzIGFueVtdKTtcbiAgICBwYWNrZXIucmVzZXQoKTtcbiAgICBjaGFyU2V0TGVuID0gY2hhcnNldC5sZW5ndGg7XG5cbiAgICBjb25zdCBsaW1pdCA9IG9zLmNwdXM/LigpPy5sZW5ndGggfHwgNDtcbiAgICAvLyDnlKjov5nlh6DkuKrmmL7npLrkuIrmnIDpnaDkuIvnmoTlrZfnrKYgKOacieS9juS6juWfuue6v+eahOmDqOWIhiksIOS9nOS4uuiuoeeulyB5b2Zmc2V0IOWfuuWHhuWAvFxuICAgIGNvbnN0IHBhdGhzID0gZm9udC5nZXRQYXRocyhcImdqcHF5XCIsIDAsIDAsICtjb25maWcuZm9udFNpemUpO1xuICAgIGNvbnN0IGJCb3hzID0gcGF0aHMubWFwKChvOiBhbnkpID0+IG8uZ2V0Qm91bmRpbmdCb3goKSk7XG4gICAgY29uc3QgbWluWTEgPSBtaW5CeShiQm94cywgKG86IGFueSkgPT4gby55MSkueTE7XG4gICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IGJsdWVCaXJkTWFwKGNoYXJzZXQsIChjaGFyKSA9PiBnZW5lcmF0ZUdseXBoSW1hZ2Uoe1xuICAgICAgICBiaW5hcnlQYXRoOiBwYXRoLmpvaW4oQklOX1BBVEgsIHByb2Nlc3MucGxhdGZvcm0sIEJJTl9NQVBbcHJvY2Vzcy5wbGF0Zm9ybV0pLFxuICAgICAgICBtaW5ZMSxcbiAgICAgICAgZm9udDogZm9udCxcbiAgICAgICAgY2hhcjogY2hhclxuICAgIH0pLCB7IGNvbmN1cnJlbmN5OiBsaW1pdCB9KTtcblxuICAgIGNvbnN0IGZhaWxlZENoYXJTZXQgPSByZW1vdmUocmVzdWx0cywgKG8pID0+IGlzTmlsKG8uZGF0YS5pbWFnZURhdGEpKS5tYXAoKG8pID0+IFtvLmRhdGEuZm9udERhdGEuaWQsIG8uZGF0YS5mb250RGF0YS5jaGFyXSk7XG4gICAgaWYgKGZhaWxlZENoYXJTZXQubGVuZ3RoID4gMCkge1xuICAgICAgICBjb25zb2xlLmxvZyhgJHtMT0dfVEFHfUZhaWxlZCBjaGFyczoke0pTT04uc3RyaW5naWZ5KGZhaWxlZENoYXJTZXQpfWApO1xuICAgICAgICBmYWlsTnVtID0gZmFpbGVkQ2hhclNldC5sZW5ndGg7XG4gICAgfVxuICAgIGlmIChyZXN1bHRzLmxlbmd0aCA8PSAwKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIk5vIHN1Y2Nlc3NmdWxseSBnZW5lcmF0ZWQgY2hhcmFjdGVyc1wiKTtcbiAgICB9XG5cbiAgICBwYWNrZXIuYWRkQXJyYXkocmVzdWx0cyBhcyBhbnlbXSk7XG4gICAgY29uc3Qgc3VjY0NoYXJzOiBJRm9udERhdGFbXSA9IFtdO1xuICAgIGNvbnN0IHBhZ2VzOiBJUGFnZURhdGFbXSA9IFtdO1xuICAgIGNvbnN0IHRleHR1cmVzID0gYXdhaXQgYmx1ZUJpcmRNYXAocGFja2VyLmJpbnMsIGFzeW5jIChiaW4sIGluZGV4KSA9PiB7XG4gICAgICAgIGNvbnN0IGZpbGxDb2xvciA9IDB4MDAwMDAwMDA7XG4gICAgICAgIGxldCBmb250SW1nID0gbmV3IEppbXAoYmluLndpZHRoLCBiaW4uaGVpZ2h0LCBmaWxsQ29sb3IpO1xuICAgICAgICBjb25zdCB0ZXh0dXJlTmFtZSA9IGAke2NvbmZpZy5leHBvcnROYW1lfV8ke2luZGV4fS5wbmdgO1xuICAgICAgICBwYWdlcy5wdXNoKHsgaWQ6IHBhZ2VzLmxlbmd0aCwgZmlsZTogcGF0aC5iYXNlbmFtZSh0ZXh0dXJlTmFtZSkgfSk7XG5cbiAgICAgICAgYmluLnJlY3RzLmZvckVhY2goKHJlY3Q6IElDb250YWluZXIpID0+IHtcbiAgICAgICAgICAgIGZvbnRJbWcuY29tcG9zaXRlKHJlY3QuZGF0YS5pbWFnZURhdGEsIHJlY3QueCwgcmVjdC55KTtcbiAgICAgICAgICAgIGNvbnN0IGNoYXJEYXRhID0gcmVjdC5kYXRhLmZvbnREYXRhO1xuICAgICAgICAgICAgY2hhckRhdGEueCA9IHJlY3QueDtcbiAgICAgICAgICAgIGNoYXJEYXRhLnkgPSByZWN0Lnk7XG4gICAgICAgICAgICBjaGFyRGF0YS5wYWdlID0gaW5kZXg7XG4gICAgICAgICAgICBzdWNjQ2hhcnMucHVzaChyZWN0LmRhdGEuZm9udERhdGEpO1xuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgYnVmZmVyID0gYXdhaXQgZm9udEltZy5nZXRCdWZmZXJBc3luYyhKaW1wLk1JTUVfUE5HKTtcbiAgICAgICAgcmV0dXJuIHsgZmlsZW5hbWU6IHRleHR1cmVOYW1lLCB0ZXh0dXJlOiBidWZmZXIgfTtcbiAgICB9KTtcbiAgICBjb25zdCBzY2FsZSA9ICtjb25maWcuZm9udFNpemUgLyBmb250LnVuaXRzUGVyRW07XG4gICAgY29uc3QgYmFzZWxpbmUgPSAoZm9udC5hc2NlbmRlciArIGZvbnQuZGVzY2VuZGVyKSAqIHNjYWxlICsgKCgrY29uZmlnLmRpc3RSYW5nZSkgPj4gMSk7XG4gICAgY29uc3QgZm9udERhdGE6IElGbnRDb25maWcgPSB7XG4gICAgICAgIHNpemU6ICtjb25maWcuZm9udFNpemUsXG4gICAgICAgIGJvbGQ6IDAsXG4gICAgICAgIGl0YWxpYzogMCxcbiAgICAgICAgcGFkZGluZzogQXJyYXkoNCkuZmlsbCgrY29uZmlnLnBhZGRpbmcpLmpvaW4oJywnKSxcbiAgICAgICAgc3BhY2luZzogXCJcIixcbiAgICAgICAgb3V0bGluZTogMCxcbiAgICAgICAgbGluZUhlaWdodDogTWF0aC5yb3VuZCgoZm9udC5hc2NlbmRlciAtIGZvbnQuZGVzY2VuZGVyKSAqIHNjYWxlICsgKCtjb25maWcuZGlzdFJhbmdlKSksXG4gICAgICAgIGJhc2U6IE1hdGgucm91bmQoYmFzZWxpbmUpLFxuICAgICAgICBzY2FsZVc6IHBhY2tlci5iaW5zWzBdLndpZHRoLFxuICAgICAgICBzY2FsZUg6IHBhY2tlci5iaW5zWzBdLmhlaWdodCxcbiAgICAgICAgcGFnZXM6IHBhY2tlci5iaW5zLmxlbmd0aCxcbiAgICAgICAgcGFja2VkOiAwLFxuICAgICAgICBhbHBoYUNobmw6IDAsXG4gICAgICAgIHJlZENobmw6IDAsXG4gICAgICAgIGdyZWVuQ2hubDogMCxcbiAgICAgICAgYmx1ZUNobmw6IDAsXG4gICAgICAgIHNtb290aDogMSxcbiAgICAgICAgcGFnZURhdGE6IHBhZ2VzLFxuICAgICAgICBjaGFyRGF0YTogc3VjY0NoYXJzXG4gICAgfTtcblxuICAgIHJldHVybiB7IHRleHR1cmVzLCBmb250RGF0YSB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBkZWxVbnVzZWRUZXh0dXJlcyhvdXRQYXRoOiBzdHJpbmcsIGxlbjogbnVtYmVyKSB7XG4gICAgaWYgKGxlbiA+PSBNQVhfVEVYVFVSRVNfTlVNKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgICBmb3IgKGxldCBpbmRleCA9IGxlbjsgaW5kZXggPD0gTUFYX1RFWFRVUkVTX05VTTsgKytpbmRleCkge1xuICAgICAgICAgICAgY29uc3QgZmluYWxQYXRoID0gcGF0aC5qb2luKG91dFBhdGgsIGAke2NvbmZpZy5leHBvcnROYW1lfV8ke2luZGV4fS5wbmdgKTtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGAke0xPR19UQUd9RGVsZXRlIGFzc2V0ICR7ZmluYWxQYXRofWApO1xuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAnZGVsZXRlLWFzc2V0JywgZmluYWxQYXRoKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBjYXRjaCAoZXJyKSB7XG4gICAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZXhwb3J0Rm9udCgpIHtcbiAgICB0cnkge1xuICAgICAgICBsZXQgY2hlY2sgPSBmcy5leGlzdHNTeW5jKGAke1RFTVBfUEFUSH1gKTtcbiAgICAgICAgaWYgKCFjaGVjaykge1xuICAgICAgICAgICAgZnMubWtkaXJTeW5jKGAke1RFTVBfUEFUSH1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHByb2dyZXNzID0gMDtcbiAgICAgICAgY2hhclNldExlbiA9IDA7XG4gICAgICAgIHN1Y2NOdW0gPSAwO1xuICAgICAgICBmYWlsTnVtID0gMDtcblxuICAgICAgICBjb25zdCBvdXRQYXRoID0gcmVzb2x2ZVByb2pQYXRoKGNvbmZpZy5leHBvcnREaXIgYXMgc3RyaW5nKTtcbiAgICAgICAgY29uc3QgeyB0ZXh0dXJlcywgZm9udERhdGEgfSA9IGF3YWl0IGdlbkJpdG1hcEZvbnRzKCk7XG4gICAgICAgIEVkaXRvci5NZXNzYWdlLnNlbmQocGFja2FnZUpTT04ubmFtZSwgXCJ1cGRhdGUtcHJvZ3Jlc3NcIiwgc3VjY051bSAvIE1hdGgubWF4KDEsIGNoYXJTZXRMZW4pLCBcIldyaXRpbmcgdGV4dHVyZXMuLi5cIik7XG4gICAgICAgIHRleHR1cmVzLmZvckVhY2goKHRleHR1cmUsIGluZGV4KSA9PiB7XG4gICAgICAgICAgICBjb25zdCBwbmdQYXRoID0gcGF0aC5qb2luKG91dFBhdGgsIHRleHR1cmUuZmlsZW5hbWUpO1xuICAgICAgICAgICAgZnMud3JpdGVGaWxlKHBuZ1BhdGgsIHRleHR1cmUudGV4dHVyZSwgKGVycjogYW55KSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgJHtMT0dfVEFHfVdyaXRlIHBuZyAke2luZGV4fSBGQUlMOiAke3BuZ1BhdGh9ICR7ZXJyfWApO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGAke0xPR19UQUd9V3JpdGUgcG5nICR7aW5kZXh9IHN1Y2M6ICR7cG5nUGF0aH1gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8g5Yig6Zmk5aSa5L2Z55qE5Zu+54mHXG4gICAgICAgIGRlbFVudXNlZFRleHR1cmVzKG91dFBhdGgsIHRleHR1cmVzLmxlbmd0aCk7XG5cbiAgICAgICAgLy8g5YaZ5YWlanNvblxuICAgICAgICBFZGl0b3IuTWVzc2FnZS5zZW5kKHBhY2thZ2VKU09OLm5hbWUsIFwidXBkYXRlLXByb2dyZXNzXCIsIHN1Y2NOdW0gLyBNYXRoLm1heCgxLCBjaGFyU2V0TGVuKSwgXCJXcml0aW5nIGpzb24uLi5cIik7XG4gICAgICAgIGNvbnN0IGpzb25QYXRoID0gcGF0aC5qb2luKG91dFBhdGgsIGAke2NvbmZpZy5leHBvcnROYW1lfS5qc29uYCk7XG4gICAgICAgIGZzLndyaXRlRmlsZShqc29uUGF0aCwgSlNPTi5zdHJpbmdpZnkoZm9udERhdGEpLCAoZXJyOiBhbnkpID0+IHtcbiAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgJHtMT0dfVEFHfVdyaXRlIGpzb24gRkFJTDogJHtqc29uUGF0aH0gJHtlcnJ9YCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGAke0xPR19UQUd9V3JpdGUganNvbiBzdWNjOiAke2pzb25QYXRofWApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICAvLyDliLfmlrDotYTmupBcbiAgICAgICAgY29uc3QgdGlwcyA9IChmYWlsTnVtIDw9IDApID8gXCJTVUNDRVNTXCIgOiBgRE9ORSEgZmFpbDoke2ZhaWxOdW19YDtcbiAgICAgICAgRWRpdG9yLk1lc3NhZ2Uuc2VuZChwYWNrYWdlSlNPTi5uYW1lLCBcInVwZGF0ZS1wcm9ncmVzc1wiLCBzdWNjTnVtIC8gTWF0aC5tYXgoMSwgY2hhclNldExlbiksIHRpcHMpO1xuICAgICAgICBpZiAoKGNvbmZpZy5leHBvcnREaXIgYXMgc3RyaW5nKS5zdGFydHNXaXRoKFBST0pfUFJFRklYKSkge1xuICAgICAgICAgICAgY29uc3QgZXhwb3J0RGlyID0gKGNvbmZpZy5leHBvcnREaXIgYXMgc3RyaW5nKS5yZXBsYWNlKFBST0pfUFJFRklYLCBEQl9QUkVGSVgpO1xuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcImFzc2V0LWRiXCIsIFwicmVmcmVzaC1hc3NldFwiLCBleHBvcnREaXIpO1xuICAgICAgICAgICAgY29uc29sZS5sb2coYCR7TE9HX1RBR31SZWZyZXNoIGFzc2V0IGZvciAke2V4cG9ydERpcn0gZG9uZS5gKTtcbiAgICAgICAgfVxuXG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoYCR7TE9HX1RBR31leHBvcnRGb250IGVycm9yICR7ZXJyfWApO1xuICAgIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gYnVpbGRVcGRhdGVkVGV4dHVyZXMob3V0UGF0aDogc3RyaW5nLCBqc29uUGF0aDogc3RyaW5nKSB7XG4gICAgLy8g6I635Y+WanNvbuW8leeUqOeahOWbvueJh+i1hOa6kFxuICAgIGNvbnN0IHRleHR1cmVOYW1lcyA9IFV0aWxzLnBhcnNlVGV4dHVyZXMoanNvblBhdGgpO1xuICAgIGlmICghdGV4dHVyZU5hbWVzIHx8IHRleHR1cmVOYW1lcy5sZW5ndGggPD0gMCkge1xuICAgICAgICBjb25zb2xlLmVycm9yKGAke0xPR19UQUd9cGFyc2VUZXh0dXJlcyBvZiAke2pzb25QYXRofSBmYWlsIWApO1xuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGNvbnN0IHV1aWRHZXRGdW5jID0gKG1ldGE6IGFueSkgPT4ge1xuICAgICAgICBpZiAoIW1ldGEuc3ViTWV0YXMgfHwgT2JqZWN0LmtleXMobWV0YS5zdWJNZXRhcykubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICByZXR1cm4gbWV0YS51dWlkOyAvLyDmsqHmnInlrZDnuqfml7bkvb/nlKjkuLtVVUlEXG4gICAgICAgIH1cblxuICAgICAgICAvLyDmnInlrZDnuqfml7bkvb/nlKjnrKzkuIDkuKrvvIjmiJbmoLnmja7kuJrliqHpgLvovpHpgInmi6nvvIlcbiAgICAgICAgY29uc3QgZmlyc3RTdWIgPSBPYmplY3QudmFsdWVzKG1ldGEuc3ViTWV0YXMpWzBdIGFzIGFueTtcbiAgICAgICAgcmV0dXJuIGZpcnN0U3ViPy51dWlkIHx8IG1ldGEudXVpZDtcbiAgICB9O1xuXG4gICAgLy8g5p+l6K+i5Zu+54mH6LWE5rqQdXVpZO+8jOaehOmAoElDb21wVGV4dHVyZVxuICAgIGNvbnN0IHRleHR1cmVzOiBJQ29tcFRleHR1cmVbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgdGV4dHVyZU5hbWUgb2YgdGV4dHVyZU5hbWVzKSB7XG4gICAgICAgIGNvbnN0IHBuZ1BhdGggPSBwYXRoLmpvaW4ob3V0UGF0aCwgdGV4dHVyZU5hbWUpO1xuICAgICAgICBjb25zdCBtZXRhID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncXVlcnktYXNzZXQtbWV0YScsIHBuZ1BhdGgpO1xuICAgICAgICBjb25zdCB1dWlkID0gdXVpZEdldEZ1bmMobWV0YSk7XG4gICAgICAgIGlmICghdXVpZCkge1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcihgJHtMT0dfVEFHfVF1ZXJ5IHV1aWQgb2YgJHt0ZXh0dXJlTmFtZX0gZmFpbCFgKTtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cbiAgICAgICAgdGV4dHVyZXMucHVzaCh7IF9fdXVpZF9fOiB1dWlkLCBfX2V4cGVjdGVkVHlwZV9fOiBcImNjLlRleHR1cmUyRFwiIH0pO1xuICAgICAgICBjb25zb2xlLmxvZyhgJHtMT0dfVEFHfSR7cGF0aC5yZWxhdGl2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCBwbmdQYXRoKX06ICR7dXVpZH1gKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGV4dHVyZXM7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZUFzc2V0KGZpbGVQYXRoOiBzdHJpbmcsIGpzb25VdWlkOiBzdHJpbmcsIHRleHR1cmVzOiBJQ29tcFRleHR1cmVbXSk6IGJvb2xlYW4ge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGRhdGEgPSBmcy5yZWFkRmlsZVN5bmMoZmlsZVBhdGgsICd1dGYtOCcpO1xuICAgICAgICBjb25zdCBhcnJheTogSUNvbXBbXSA9IEpTT04ucGFyc2UoZGF0YSk7XG4gICAgICAgIGNvbnN0IHVwZGF0ZWQgPSBhcnJheS5tYXAob2JqID0+IHtcbiAgICAgICAgICAgIGlmICgob2JqLl9mb250Py5fX3V1aWRfXyA9PT0ganNvblV1aWQpICYmICFVdGlscy5jaGVja1RleHR1cmVzTWF0Y2gob2JqLnRleHR1cmVzLCB0ZXh0dXJlcykpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAuLi5vYmosXG4gICAgICAgICAgICAgICAgICAgIHRleHR1cmVzOiBbLi4udGV4dHVyZXNdXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBvYmo7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGZzLndyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIEpTT04uc3RyaW5naWZ5KHVwZGF0ZWQsIG51bGwsIDIpKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG5cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihgJHtMT0dfVEFHfXVwZGF0ZUFzc2V0IGVycm9yICR7ZXJyfWApO1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBzeW5jUmVzKCkge1xuICAgIHRyeSB7XG4gICAgICAgIC8vIOiOt+WPlmpzb27mlofku7Z1dWlkXG4gICAgICAgIGNvbnN0IG91dFBhdGggPSByZXNvbHZlUHJvalBhdGgoY29uZmlnLmV4cG9ydERpciBhcyBzdHJpbmcpO1xuICAgICAgICBjb25zdCBqc29uUGF0aCA9IHBhdGguam9pbihvdXRQYXRoLCBgJHtjb25maWcuZXhwb3J0TmFtZX0uanNvbmApO1xuICAgICAgICBjb25zdCBqc29uVXVpZCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3F1ZXJ5LXV1aWQnLCBqc29uUGF0aCk7XG4gICAgICAgIGlmICghanNvblV1aWQpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYCR7TE9HX1RBR31RdWVyeSB1dWlkIG9mICR7anNvblBhdGh9IGZhaWwhYCk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICAvLyDmn6Xor6LmiYDmnInnlKjliLDnmoTotYTmupBcbiAgICAgICAgY29uc29sZS5sb2coYCR7TE9HX1RBR31qc29uVXVpZDoke2pzb25VdWlkfWApO1xuICAgICAgICBjb25zdCB1c2VycyA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3F1ZXJ5LWFzc2V0LXVzZXJzJywganNvblV1aWQpO1xuICAgICAgICBpZiAoIXVzZXJzKSB7XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhgJHtMT0dfVEFHfU5vIHVzZXJzIG9mICR7anNvblBhdGh9LCBub3RoaW5nIHRvIGRvLmApO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHRleHR1cmVzOiBJQ29tcFRleHR1cmVbXSB8IHVuZGVmaW5lZDtcbiAgICAgICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IHVzZXJzLmxlbmd0aDsgKytpbmRleCkge1xuICAgICAgICAgICAgY29uc3QgdXVpZCA9IHVzZXJzW2luZGV4XTtcbiAgICAgICAgICAgIGNvbnN0IGFzc2V0SW5mbyA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3F1ZXJ5LWFzc2V0LWluZm8nLCB1dWlkKTtcbiAgICAgICAgICAgIGlmICghYXNzZXRJbmZvKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS53YXJuKGAke0xPR19UQUd9UXVlcnkgYXNzZXQgb2YgJHt1dWlkfSBmYWlsIWApO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyDnlJ/miJDopoHmm7/mjaLnmoR0ZXh0dXJlc+WGheWuuVxuICAgICAgICAgICAgaWYgKCF0ZXh0dXJlcykge1xuICAgICAgICAgICAgICAgIHRleHR1cmVzID0gYXdhaXQgYnVpbGRVcGRhdGVkVGV4dHVyZXMob3V0UGF0aCwganNvblBhdGgpO1xuICAgICAgICAgICAgICAgIGlmICghdGV4dHVyZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcihgJHtMT0dfVEFHfWJ1aWxkVXBkYXRlZFRleHR1cmVzIGZhaWwhIGpzb246JHtqc29uUGF0aH1gKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8g5pu05pawXG4gICAgICAgICAgICBjb25zdCBzdWNjID0gYXdhaXQgdXBkYXRlQXNzZXQoYXNzZXRJbmZvLmZpbGUsIGpzb25VdWlkLCB0ZXh0dXJlcyEpO1xuICAgICAgICAgICAgY29uc29sZS5sb2coYCR7TE9HX1RBR30ke2luZGV4KzF9LyR7dXNlcnMubGVuZ3RofSAke2Fzc2V0SW5mby51cmx9ICR7c3VjYyA/IFwiU1VDQ1wiIDogXCJGQUlMXCJ9YCk7XG4gICAgICAgICAgICBpZiAoc3VjYykge1xuICAgICAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3JlaW1wb3J0LWFzc2V0JywgYXNzZXRJbmZvLnV1aWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoYCR7TE9HX1RBR31TeW5jIHJlcyBmYWlsISAke2Vycn1gKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbn1cblxuLyoqXG4gKiBAZW4gXG4gKiBAemgg5Li65omp5bGV55qE5Li76L+b56iL55qE5rOo5YaM5pa55rOVXG4gKi9cbmV4cG9ydCBjb25zdCBtZXRob2RzOiB7IFtrZXk6IHN0cmluZ106ICguLi5hbnk6IGFueSkgPT4gYW55IH0gPSB7XG5cbiAgICBvcGVuUGFuZWwoKSB7XG4gICAgICAgIEVkaXRvci5QYW5lbC5vcGVuKHBhY2thZ2VKU09OLm5hbWUpO1xuICAgIH0sXG5cbiAgICBvblBhbmVsSW5pdCgpIHtcbiAgICAgICAgRWRpdG9yLk1lc3NhZ2Uuc2VuZChwYWNrYWdlSlNPTi5uYW1lLCBcInJlZnJlc2gtY29uZmlnXCIsIGNvbmZpZyk7XG4gICAgfSxcblxuICAgIG9uQ2hhbmdlQ29uZmlnKGtleTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nIHwgbnVtYmVyKSB7XG4gICAgICAgIGNvbmZpZ1trZXldID0gdmFsdWU7XG4gICAgfSxcblxuICAgIG9uQ2xpY2tCdG5TeW5jKCkge1xuICAgICAgICBzeW5jUmVzKCk7XG4gICAgfSxcblxuICAgIG9uQ2xpY2tCdG5TYXZlKGFyZykge1xuICAgICAgICBpZiAoYXJnKSB7XG4gICAgICAgICAgICBjb25maWcgPSBhcmc7XG4gICAgICAgIH1cbiAgICAgICAgd3JpdGVDb25maWcoKTtcbiAgICB9LFxuXG4gICAgb25DbGlja0J0bkV4cG9ydCgpIHtcbiAgICAgICAgZXhwb3J0Rm9udCgpO1xuICAgIH1cbn07XG5cbi8qKlxuICogQGVuIEhvb2tzIHRyaWdnZXJlZCBhZnRlciBleHRlbnNpb24gbG9hZGluZyBpcyBjb21wbGV0ZVxuICogQHpoIOaJqeWxleWKoOi9veWujOaIkOWQjuinpuWPkeeahOmSqeWtkFxuICovXG5leHBvcnQgZnVuY3Rpb24gbG9hZCgpIHtcbiAgICByZWFkQ29uZmlnKCk7XG59XG5cbi8qKlxuICogQGVuIEhvb2tzIHRyaWdnZXJlZCBhZnRlciBleHRlbnNpb24gdW5pbnN0YWxsYXRpb24gaXMgY29tcGxldGVcbiAqIEB6aCDmianlsZXljbjovb3lrozmiJDlkI7op6blj5HnmoTpkqnlrZBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVubG9hZCgpIHsgfVxuXG4iXX0=