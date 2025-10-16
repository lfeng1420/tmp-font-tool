import { PathCommand } from "opentype.js";
import { isNumber, round, chain, sortBy, map } from 'lodash';
import { ICompTexture, IFntConfig } from "./interface";
const fs = require("fs");

export default class Utils {
    public static getShapeDesc(contours: PathCommand[][]) {
        let shapeDesc = '';
        contours.forEach((contour) => {
            shapeDesc += '{';
            const lastIndex = contour.length - 1;
            let _x: number, _y: number;
            const firstCommand = contour[0];
            contour.forEach((command, index) => {
                this.roundAllValue(command, 3);
                if (command.type === 'Z') {
                    if (firstCommand.type !== 'Z' && (firstCommand.x !== _x || firstCommand.y !== _y)) {
                        shapeDesc += '# ';
                    }
                } else {
                    if (command.type === 'C') {
                        shapeDesc += `(${command.x1}, ${command.y1}; ${command.x2}, ${command.y2}); `;
                    } else if (command.type === 'Q') {
                        shapeDesc += `(${command.x1}, ${command.y1}); `;
                    }
                    shapeDesc += `${command.x}, ${command.y}`;
                    _x = command.x;
                    _y = command.y;
                    if (index !== lastIndex) {
                        shapeDesc += '; ';
                    }
                }
            });
            shapeDesc += '}';
        });
        return shapeDesc;
    }

    public static parseTextures(jsonPath: string) {
        try {
            let data = fs.readFileSync(jsonPath, "utf-8");
            const fntConf: IFntConfig = JSON.parse(data);
            if (fntConf?.pageData?.length <= 0) {
                return undefined;
            }

            const textureMap: Map<number, string> = new Map();
            for (const page of fntConf.pageData) {
                textureMap.set(page.id, page.file);
            }
            return chain(Array.from(textureMap.entries())).sortBy(([key]) => key).map(([, value]) => value).value();

        } catch (err) {
            console.error(`${err}`);
            return undefined;
        }
    }

    public static checkTexturesMatch(texturesSrc?: ICompTexture[], texturesDst?: ICompTexture[]) {
        if (!texturesSrc || !texturesDst) {
            return false;
        }

        if (texturesSrc.length !== texturesDst.length) {
            return false;
        }

        for (let index = 0; index < texturesDst.length; ++index) {
            if (texturesSrc[index].__uuid__ !== texturesDst[index].__uuid__) {
                return false;
            }
        }

        return true;
    }


    private static roundAllValue(obj: PathCommand, decimal: number = 0) {
        Object.keys(obj).forEach(key => {
            const value = (obj as any)[key];
            if (typeof value === 'object' && value !== null) {
                this.roundAllValue(value, decimal);
            } else if (isNumber(value)) {
                const num = parseFloat(value.toString());
                (obj as any)[key] = round(num, decimal);
            }
        });
    }
}
