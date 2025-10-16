import { readFileSync } from 'fs-extra';
import { join } from 'path';

const { shell } = require("electron");

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

/**
 * @zh 如果希望兼容 3.3 之前的版本可以使用下方的代码
 * @en You can add the code below if you want compatibility with versions prior to 3.3
 */
// Editor.Panel.define = Editor.Panel.define || function(options: any) { return options }
module.exports = Editor.Panel.define({
    listeners: {
        show() { console.log('show'); },
        hide() { console.log('hide'); },
    },
    template: readFileSync(join(__dirname, '../../../static/template/default/index.html'), 'utf-8'),
    style: readFileSync(join(__dirname, '../../../static/style/default/index.css'), 'utf-8'),
    $: {
        fontPath: "#fontPath",
        exportDir: "#exportDir",
        exportName: "#exportName",

        textSelect: "#textSelect",
        textStrElement: "#textStrElement",
        textPathElement: "#textPathElement",
        textStr: "#textStr",
        textPath: "#textPath",

        fontSize: "#fontSize",
        padding: "#padding",
        offsetX: "#offsetX",
        offsetY: "#offsetY",
        distRange: "#distRange",
        smartSize: "#smartSize",
        pot: "#pot",
        square: "#square",
        width: "#width",
        height: "#height",

        progressBar: '#progressBar',
        progress: '#progress',
        btnSync: "#btnSync",
        btnSave: "#btnSave",
        btnExport: "#btnExport",
    },
    methods: {
        refreshConfig(arg: any) {
            config = arg;
            //@ts-ignore
            this.$.fontPath.value = config.fontPath;
            //@ts-ignore
            this.$.exportDir.value = config.exportDir;
            //@ts-ignore
            this.$.exportName.value = config.exportName;

            //@ts-ignore
            this.$.textSelect.value = config.textFrom;
            //@ts-ignore
            this.$.textStrElement.style.display = Number(this.$.textSelect.value) === 0 ? "" : "none";
            //@ts-ignore
            this.$.textPathElement.style.display = Number(this.$.textSelect.value) === 1 ? "" : "none";
            //@ts-ignore
            this.$.textStr.value = config.textStr;
            //@ts-ignore
            this.$.textPath.value = config.textPath;

            //@ts-ignore
            this.$.fontSize.value = config.fontSize;
            //@ts-ignore
            this.$.padding.value = config.padding;
            //@ts-ignore
            this.$.offsetX.value = config.offsetX;
            //@ts-ignore
            this.$.offsetY.value = config.offsetY;
            //@ts-ignore
            this.$.distRange.value = config.distRange;
            //@ts-ignore
            this.$.smartSize.value = config.smartSize;
            //@ts-ignore
            this.$.pot.value = config.pot;
            //@ts-ignore
            this.$.square.value = config.square;
            //@ts-ignore
            this.$.width.value = config.width;
            //@ts-ignore
            this.$.height.value = config.height;
        },
        updateProgress(progress: number, desc: string) {
            const value = (progress * 100).toFixed(2);
            //@ts-ignore
            this.$.progressBar.value = value;
            //@ts-ignore
            this.$.progress.value = (desc.length <= 0) ? `${value}%` : desc;
        }
    },
    ready() {
        // 初始化
        Editor.Message.send("tmp-font-tool", "panel-init");

        //@ts-ignore
        this.$.exportName.addEventListener("confirm", () => {
            //@ts-ignore
            Editor.Message.send("tmp-font-tool", "change-config", "exportFileName", this.$.exportName.value);
        });
        //@ts-ignore
        this.$.textSelect.addEventListener("confirm", () => {
            //@ts-ignore
            this.$.textStrElement.style.display = Number(this.$.textSelect.value) === 0 ? "" : "none";
            //@ts-ignore
            this.$.textPathElement.style.display = Number(this.$.textSelect.value) === 1 ? "" : "none";
            //@ts-ignore
            Editor.Message.send("tmp-font-tool", "change-config", "textFrom", Number(this.$.textSelect.value));
        });
        //@ts-ignore
        this.$.textStr.addEventListener("confirm", () => {
            //@ts-ignore
            Editor.Message.send("tmp-font-tool", "change-config", "textStr", this.$.textStr.value);
        });
        //@ts-ignore
        this.$.fontSize.addEventListener("confirm", () => {
            //@ts-ignore
            Editor.Message.send("tmp-font-tool", "change-config", "fontSize", this.$.fontSize.value);
        });
        //@ts-ignore
        this.$.padding.addEventListener("confirm", () => {
            //@ts-ignore
            Editor.Message.send("tmp-font-tool", "change-config", "padding", this.$.padding.value);
        });
        //@ts-ignore
        this.$.offsetX.addEventListener("confirm", () => {
            //@ts-ignore
            Editor.Message.send("tmp-font-tool", "change-config", "offsetX", this.$.offsetX.value);
        });
        //@ts-ignore
        this.$.offsetY.addEventListener("confirm", () => {
            //@ts-ignore
            Editor.Message.send("tmp-font-tool", "change-config", "offsetY", this.$.offsetY.value);
        });
        //@ts-ignore
        this.$.distRange.addEventListener("confirm", () => {
            //@ts-ignore
            Editor.Message.send("tmp-font-tool", "change-config", "distRange", this.$.distRange.value);
        });
        //@ts-ignore
        this.$.smartSize.addEventListener("confirm", () => {
            //@ts-ignore
            Editor.Message.send("tmp-font-tool", "change-config", "smartSize", this.$.smartSize.value);
        });
        //@ts-ignore
        this.$.pot.addEventListener("confirm", () => {
            //@ts-ignore
            Editor.Message.send("tmp-font-tool", "change-config", "pot", this.$.pot.value);
        });
        //@ts-ignore
        this.$.square.addEventListener("confirm", () => {
            //@ts-ignore
            Editor.Message.send("tmp-font-tool", "change-config", "square", this.$.square.value);
        });
        //@ts-ignore
        this.$.width.addEventListener("confirm", () => {
            //@ts-ignore
            Editor.Message.send("tmp-font-tool", "change-config", "width", this.$width.value);
        });
        //@ts-ignore
        this.$.height.addEventListener("confirm", () => {
            //@ts-ignore
            Editor.Message.send("tmp-font-tool", "change-config", "height", this.$height.value);
        });

        let saveCall = () => {
            //@ts-ignore
            config.exportName = this.$.exportName.value;
            //@ts-ignore
            config.exportDir = this.$.exportDir.value;
            //@ts-ignore
            config.fontPath = this.$.fontPath.value;
            //@ts-ignore
            config.textFrom = Number(this.$.textSelect.value);
            //@ts-ignore
            config.textStr = this.$.textStr.value;
            //@ts-ignore
            config.textPath = this.$.textPath.value;
            //@ts-ignore
            config.fontSize = this.$.fontSize.value;
            //@ts-ignore
            config.padding = this.$.padding.value;
            //@ts-ignore
            config.offsetX = this.$.offsetX.value;
            //@ts-ignore
            config.offsetY = this.$.offsetY.value;
            //@ts-ignore
            config.distRange = this.$.distRange.value;
            //@ts-ignore
            config.smartSize = this.$.smartSize.value;
            //@ts-ignore
            config.pot = this.$.pot.value;
            //@ts-ignore
            config.square = this.$.square.value;
            //@ts-ignore
            config.width = this.$.width.value;
            //@ts-ignore
            config.height = this.$.height.value;
            Editor.Message.send("tmp-font-tool", "click-btn-save", config);
        };
        //@ts-ignore
        this.$.btnSync.addEventListener("confirm", () => {
            Editor.Message.send("tmp-font-tool", "click-btn-sync");
        });
        //@ts-ignore
        this.$.btnSave.addEventListener("confirm", () => {
            saveCall();
        });
        //@ts-ignore
        this.$.btnExport.addEventListener("confirm", () => {
            saveCall();
            Editor.Message.send("tmp-font-tool", "click-btn-export");
        });
    },
    beforeClose() { },
    close() { },
});
