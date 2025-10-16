// @ts-ignore
import packageJSON from '../package.json';
import { remove, uniq, minBy, isNil } from 'lodash';
import path from 'path';
import { MaxRectsPacker } from 'maxrects-packer';
import { fromCallback, map as blueBirdMap } from 'bluebird';
import { Font, loadSync, PathCommand } from 'opentype.js';
import { IComp, ICompTexture, IContainer, IFntConfig, IFontData, IPageData } from './interface';
import { exec } from 'child_process';
import Utils from './utils';
import Jimp from 'jimp';
import { pipeline } from 'stream';

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
const BIN_MAP: Record<string, string> = {
    "darwin": 'msdfgen.osx',
    "win32": 'msdfgen.exe',
};

let config: { [key: string]: number | string | boolean } = {
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

function isFileExist(path: string) {
    return new Promise((resolve, reject) => {
        fs.access(path, fs.constants.F_OK, (err: any) => {
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
    } catch (err) {
        console.error(`${LOG_TAG}readConfig error ${err}`);
    }
}

function writeConfig() {
    try {
        let data = JSON.stringify(config);
        fs.writeFileSync(CONFIG_PATH, data);
        console.log(`${LOG_TAG}Write config: ${path.relative(Editor.Project.path, CONFIG_PATH)}`);
    } catch (err) {
        console.error(`${LOG_TAG}writeConfig error ${err}`);
    }
}

function handleCharset() {
    let charset: string[];
    if (config.textFrom === 1) {
        const textPath = resolveProjPath(config.textPath as string);
        charset = fs.readFileSync(textPath, 'utf-8').split('');
    }
    else {
        charset = (config.textStr as string).split('');
    }
    charset = uniq(charset);
    remove(charset, (o) => ['\n', '\r', '\t'].includes(o));

    return charset;
}

function resolveProjPath(tmpPath: string) {
    if (tmpPath.startsWith(PROJ_PREFIX)) {
        return path.join(Editor.Project.path, tmpPath.substring(PROJ_PREFIX.length));
    }
    return tmpPath;
}


async function generateGlyphImage(args: any) {
    const { binaryPath, minY1, font, char } = args;
    const glyph = font.charToGlyph(char);
    const contours: PathCommand[][] = [];
    let currentContour: PathCommand[] = [];

    const gPath = glyph.getPath(0, 0, +config.fontSize);
    const pathCommands = gPath.commands;
    const bBox = gPath.getBoundingBox();
    pathCommands.forEach((command: PathCommand) => {
        currentContour.push(command);
        if (command.type === 'Z') { // end of contour
            contours.push(currentContour);
            currentContour = [];
        }
    });
    const shapeDesc = Utils.getShapeDesc(contours);
    if (contours.some(cont => cont.length === 1)) {
        console.log('length is 1, failed to normalize glyph');
    };

    const scale = +config.fontSize / font.unitsPerEm;
    const pad = +config.distRange >> 1;
    let width = Math.round(bBox.x2 - bBox.x1) + pad + pad;
    let height = Math.round(bBox.y2 - bBox.y1) + pad + pad;
    let xOffset = Math.round(-bBox.x1) + pad;
    let yOffset = Math.round(-bBox.y1) + pad;
    const shapeDescPath = path.join(TEMP_PATH, `${char.charCodeAt(0)}.txt`);
    fs.writeFileSync(shapeDescPath, shapeDesc);
    const command = `"${binaryPath}" sdf -format text -stdout -size ${width} ${height} -translate ${xOffset} ${yOffset} -pxrange ${+config.distRange} -shapedesc "${shapeDescPath}"`;
    const result = await fromCallback((callback) => {
        exec(command, { maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
            const container: IContainer = {
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
            const rawImageData = stdout.match(/([0-9a-fA-F]+)/g)!.map(str => parseInt(str, 16));
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
            } else if (channelCount === 4) {
                for (let i = 0; i < rawImageData.length; i += channelCount) {
                    pixels.push(...rawImageData.slice(i, i + channelCount));
                }
            } else {
                for (let i = 0; i < rawImageData.length; i += channelCount) {
                    pixels.push(rawImageData[i], rawImageData[i], rawImageData[i], rawImageData[i]);
                }
            }
            let imageData = undefined;
            if (rawImageData.some(x => x !== 0) || char === ' ') { // if character is blank
                const buffer = new Uint8ClampedArray(pixels);
                imageData = new Jimp({ data: buffer, width: width, height: height });
            }
            container.data.imageData = imageData;

            progress = ++succNum / Math.max(1, charSetLen);
            Editor.Message.send(packageJSON.name, "update-progress", progress, "");
            callback(null, container);
        });
    });
    if (fs.existsSync(shapeDescPath)) {
        fs.unlinkSync(shapeDescPath);
    }
    return result as IContainer;
}

async function genBitmapFonts() {
    const charset = handleCharset();
    const fontPath = config.fontPath as string;
    const font = loadSync(resolveProjPath(fontPath));
    const packer = new MaxRectsPacker(+config.width, +config.height, +config.padding, {
        smart: config.smartSize as boolean,
        pot: config.pot as boolean,
        square: config.square as boolean
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
    packer.addArray(rects as any[]);
    packer.reset();
    charSetLen = charset.length;

    const limit = os.cpus?.()?.length || 4;
    // 用这几个显示上最靠下的字符 (有低于基线的部分), 作为计算 yoffset 基准值
    const paths = font.getPaths("gjpqy", 0, 0, +config.fontSize);
    const bBoxs = paths.map((o: any) => o.getBoundingBox());
    const minY1 = minBy(bBoxs, (o: any) => o.y1).y1;
    const results = await blueBirdMap(charset, (char) => generateGlyphImage({
        binaryPath: path.join(BIN_PATH, process.platform, BIN_MAP[process.platform]),
        minY1,
        font: font,
        char: char
    }), { concurrency: limit });

    const failedCharSet = remove(results, (o) => isNil(o.data.imageData)).map((o) => [o.data.fontData.id, o.data.fontData.char]);
    if (failedCharSet.length > 0) {
        console.log(`${LOG_TAG}Failed chars:${JSON.stringify(failedCharSet)}`);
        failNum = failedCharSet.length;
    }
    if (results.length <= 0) {
        throw new Error("No successfully generated characters");
    }

    packer.addArray(results as any[]);
    const succChars: IFontData[] = [];
    const pages: IPageData[] = [];
    const textures = await blueBirdMap(packer.bins, async (bin, index) => {
        const fillColor = 0x00000000;
        let fontImg = new Jimp(bin.width, bin.height, fillColor);
        const textureName = `${config.exportName}_${index}.png`;
        pages.push({ id: pages.length, file: path.basename(textureName) });

        bin.rects.forEach((rect: IContainer) => {
            fontImg.composite(rect.data.imageData, rect.x, rect.y);
            const charData = rect.data.fontData;
            charData.x = rect.x;
            charData.y = rect.y;
            charData.page = index;
            succChars.push(rect.data.fontData);
        });
        const buffer = await fontImg.getBufferAsync(Jimp.MIME_PNG);
        return { filename: textureName, texture: buffer };
    });
    const scale = +config.fontSize / font.unitsPerEm;
    const baseline = (font.ascender + font.descender) * scale + ((+config.distRange) >> 1);
    const fontData: IFntConfig = {
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

async function delUnusedTextures(outPath: string, len: number) {
    if (len >= MAX_TEXTURES_NUM) {
        return;
    }

    try {
        for (let index = len; index <= MAX_TEXTURES_NUM; ++index) {
            const finalPath = path.join(outPath, `${config.exportName}_${index}.png`);
            console.log(`${LOG_TAG}Delete asset ${finalPath}`);
            await Editor.Message.request('asset-db', 'delete-asset', finalPath);
        }
    }
    catch (err) {
    };
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

        const outPath = resolveProjPath(config.exportDir as string);
        const { textures, fontData } = await genBitmapFonts();
        Editor.Message.send(packageJSON.name, "update-progress", succNum / Math.max(1, charSetLen), "Writing textures...");
        textures.forEach((texture, index) => {
            const pngPath = path.join(outPath, texture.filename);
            fs.writeFile(pngPath, texture.texture, (err: any) => {
                if (err) {
                    console.log(`${LOG_TAG}Write png ${index} FAIL: ${pngPath} ${err}`);
                } else {
                    console.log(`${LOG_TAG}Write png ${index} succ: ${pngPath}`);
                }
            });
        });

        // 删除多余的图片
        delUnusedTextures(outPath, textures.length);

        // 写入json
        Editor.Message.send(packageJSON.name, "update-progress", succNum / Math.max(1, charSetLen), "Writing json...");
        const jsonPath = path.join(outPath, `${config.exportName}.json`);
        fs.writeFile(jsonPath, JSON.stringify(fontData), (err: any) => {
            if (err) {
                console.log(`${LOG_TAG}Write json FAIL: ${jsonPath} ${err}`);
            } else {
                console.log(`${LOG_TAG}Write json succ: ${jsonPath}`);
            }
        });

        // 刷新资源
        const tips = (failNum <= 0) ? "SUCCESS" : `DONE! fail:${failNum}`;
        Editor.Message.send(packageJSON.name, "update-progress", succNum / Math.max(1, charSetLen), tips);
        if ((config.exportDir as string).startsWith(PROJ_PREFIX)) {
            const exportDir = (config.exportDir as string).replace(PROJ_PREFIX, DB_PREFIX);
            await Editor.Message.request("asset-db", "refresh-asset", exportDir);
            console.log(`${LOG_TAG}Refresh asset for ${exportDir} done.`);
        }

    } catch (err) {
        console.error(`${LOG_TAG}exportFont error ${err}`);
    }
}

async function buildUpdatedTextures(outPath: string, jsonPath: string) {
    // 获取json引用的图片资源
    const textureNames = Utils.parseTextures(jsonPath);
    if (!textureNames || textureNames.length <= 0) {
        console.error(`${LOG_TAG}parseTextures of ${jsonPath} fail!`);
        return undefined;
    }

    const uuidGetFunc = (meta: any) => {
        if (!meta.subMetas || Object.keys(meta.subMetas).length === 0) {
            return meta.uuid; // 没有子级时使用主UUID
        }

        // 有子级时使用第一个（或根据业务逻辑选择）
        const firstSub = Object.values(meta.subMetas)[0] as any;
        return firstSub?.uuid || meta.uuid;
    };

    // 查询图片资源uuid，构造ICompTexture
    const textures: ICompTexture[] = [];
    for (const textureName of textureNames) {
        const pngPath = path.join(outPath, textureName);
        const meta = await Editor.Message.request('asset-db', 'query-asset-meta', pngPath);
        const uuid = uuidGetFunc(meta);
        if (!uuid) {
            console.error(`${LOG_TAG}Query uuid of ${textureName} fail!`);
            return undefined;
        }
        textures.push({ __uuid__: uuid, __expectedType__: "cc.Texture2D" });
        console.log(`${LOG_TAG}${path.relative(Editor.Project.path, pngPath)}: ${uuid}`);
    }

    return textures;
}

function updateAsset(filePath: string, jsonUuid: string, textures: ICompTexture[]): boolean {
    try {
        const data = fs.readFileSync(filePath, 'utf-8');
        const array: IComp[] = JSON.parse(data);
        const updated = array.map(obj => {
            if ((obj._font?.__uuid__ === jsonUuid) && !Utils.checkTexturesMatch(obj.textures, textures)) {
                return {
                    ...obj,
                    textures: [...textures]
                };
            }
            return obj;
        });

        fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
        return true;

    } catch (err) {
        console.error(`${LOG_TAG}updateAsset error ${err}`);
        return false;
    }
}

async function syncRes() {
    try {
        // 获取json文件uuid
        const outPath = resolveProjPath(config.exportDir as string);
        const jsonPath = path.join(outPath, `${config.exportName}.json`);
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

        let textures: ICompTexture[] | undefined;
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
            const succ = await updateAsset(assetInfo.file, jsonUuid, textures!);
            console.log(`${LOG_TAG}${index+1}/${users.length} ${assetInfo.url} ${succ ? "SUCC" : "FAIL"}`);
            if (succ) {
                await Editor.Message.request('asset-db', 'reimport-asset', assetInfo.uuid);
            }
        }
    } catch (err) {
        console.error(`${LOG_TAG}Sync res fail! ${err}`);
        return;
    }
}

/**
 * @en 
 * @zh 为扩展的主进程的注册方法
 */
export const methods: { [key: string]: (...any: any) => any } = {

    openPanel() {
        Editor.Panel.open(packageJSON.name);
    },

    onPanelInit() {
        Editor.Message.send(packageJSON.name, "refresh-config", config);
    },

    onChangeConfig(key: string, value: string | number) {
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
export function load() {
    readConfig();
}

/**
 * @en Hooks triggered after extension uninstallation is complete
 * @zh 扩展卸载完成后触发的钩子
 */
export function unload() { }

