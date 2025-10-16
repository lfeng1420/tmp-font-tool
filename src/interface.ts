export interface IPageData {
    id: number,
    file: string,
}

export interface ICharData {
    id: number;
    index: number;
    char: string;
    width: number;
    height: number;
    x: number;
    y: number;
    xoffset: number;
    yoffset: number;
    xadvance: number;
    page: number;
    chnl: number;
};

export interface IFntConfig {
    size: number;
    bold: number;
    italic: number;
    padding: string;
    spacing: string;
    outline: number;
    lineHeight: number;
    base: number;
    scaleW: number;
    scaleH: number;
    pages: number;
    packed: number;
    alphaChnl: number;
    redChnl: number;
    greenChnl: number;
    blueChnl: number;
    smooth: number;
    pageData: IPageData[];
    charData: ICharData[];
}

export interface IFontData {
    id: number;
    index: number;
    char: string;
    width: number;
    height: number;
    x: number;
    y: number;
    xoffset: number;
    yoffset: number;
    xadvance: number;
    page: number;
    chnl: number;
};

export interface IExtData {
    imageData?: any;
    fontData: IFontData;
}

export interface IContainer {
    data: IExtData;
    width: number;
    height: number;
    x: number;
    y: number;
}


export interface ICompFont {
    __uuid__: string,
    __expectedType__: string,
}

export interface ICompTexture {
    __uuid__: string,
    __expectedType__: string,
}

export interface IComp {
    _font?: ICompFont,
    textures?: ICompTexture[],
}