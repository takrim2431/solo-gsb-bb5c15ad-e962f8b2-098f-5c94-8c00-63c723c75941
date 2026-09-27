# 骑马钉小册子拼版预演

基于 **Node.js + Express + 原生 Canvas** 的骑马钉（saddle-stitch）拼版预演 Web 应用。

输入成品页数、每帖张数上限、装订方向与双面翻转方式后，系统会：

- 成品页数不足整帖时，**自动在末尾补空白页**；
- **固定分帖（默认）**：每帖固定张数（每帖页数 = 每帖张数 × 4），末帖不足整体补白；
- **均衡分帖（可选）**：仍以每帖张数为上限，先取最少帖数，再把整本所需纸张在各帖间均匀分配，**各帖实际张数差不超过 1**，各帖按自身页数连续编号，**空白页只出现在末帖末尾**；每帖返回 `actualSheetCount`，并汇总相对固定分帖 `savedBlankPages` 节省的空白页数；
- **章节优先分帖（可选）**：输入递增的章节起始页，系统在每帖不超过张数上限、每帖纸张数为整数的前提下规划连续页段，按「**章节被拆分次数最少 → 补白页总数最少 → 帖数最少 → 前帖优先装满**」确定唯一方案；章节末尾允许插入帖内空白，后续真实页码保持连续并正确进入下一帖；逐帖展示覆盖章节、真实页范围与补白位置；
- **按帖拆分页码**，生成每张纸正、反面的左右页位；
- 背面依据 **长边 / 短边翻转** 执行坐标变换，保证裁切折叠后的阅读顺序；
- 可选 **爬移补偿（creep compensation）**：按纸张厚度由外向内平移内层页位，画布叠加原始页位虚线框与补偿后实线框，每个页位（含空白页）输出 `offsetMm`；均衡分帖下按**各帖实际层数**独立重算；
- 可选 **纸张规格与出血 / 安全区适配检查**：输入纸张宽高、成品页宽高、出血与安全边距后，按每个正反页位的实际方向计算可用矩形，逐页位判定成品页是否放得下、出血是否落在纸张内、安全边距是否过大，并在逐张预览与清单中标出不合格页位；
- 可选 **双面生产标记**：启用适配检查后可勾选，为每张纸正、背面生成**裁切线**（四个成品页外角各两段）、**折线标**（中线上下两端）与**套准十字**（左右出血框外侧，每侧按「居中 → 1/4 → 3/4」固定候选位置顺序尝试）；线段只有**完整落在纸内、避开两侧出血框且不与同面已放置标记相交**才落位，无可用位置则**省略并逐候选返回原因**；背面标记由正面按长边 / 短边翻转做**同一物理位置的坐标变换**，保证正背套准，爬移变化后同步重算；
- 可选 **试印核验**：对照实物纸张录入 1～12 条观察（帖 / 张 / 正背面 / 左右页位 / 看到的页码或空白 / 内容朝向），服务端用同一输入重算「左/右装订 × 长/短边翻转」四种设置逐条比对，仅唯一零差异组合判定验证通过，并列最优时返回无法判定及并列组合；**无法判定时自动从尚未观察的页位计算「下一处观察建议」**（含定位与各候选预期值）；
- 可选 **印刷备料**：填写成品份数、每帖开机损耗张数、过程损耗率与每包张数，按拼版结果**各帖实际张数**逐帖计算净用纸，并以 `需领纸 = ceil((净用纸 + 开机损耗) / (1 − 过程损耗率))` **逐帖向上取整**，再汇总后按整包向上采购（**禁止先合并各帖再计算损耗**）；页面逐帖展示净用纸、开机损耗、过程损耗与需领纸及整包采购汇总，导出 JSON 的 `materialPrep` 段附带相同数据；
- 可选 **采购报价组合**：录入多条本地报价（供应商 / 每包张数 / 每包价格 / 最少 / 最多可购包数），需求张数**默认接入印刷备料的整包采购张数**，也允许**手工填写**；在满足需求与各报价边界的整数包组合中按 **「总价最低 → 超购张数最少 → 供应商数量最少 → 录入顺序（更早录入优先装满）」** 确定唯一方案，价格一律按**分（整数）精确计算**（不使用浮点比较）；页面逐报价展示采购量 / 金额 / 余量，无可行组合时给出**具体缺口张数**，导出 JSON 的 `purchaseQuotes` 段附带相同数据；
- 可选 **双版本共版印刷清单**：输入 A、B 两版成品份数及 B 版相对 A 版改动的真实页码（支持单页与区间，自动去重并校验页码范围），沿用当前分帖、补白、装订与翻转后的页位**逐张逐面**判定——无改动页的面**共用一块印版**（印次 = A + B），含改动页的面**拆成 A、B 两块印版**各按自身份数印刷，同张纸正背面独立判定；页面逐面展示帖 / 张 / 面 / 页码 / 印版归属与印次汇总，导出 JSON 的 `dualVersion` 段附带相同清单；
- 可选 **库存批次领纸**（需先启用印刷备料）：录入 1～12 个库存批次（批号 / 可用张数 / 允许使用的帖号，允许帖号留空 = 通用批），各帖需求自动取自备料的**需领纸 `requiredSheets`**；批次可拆给多帖、同帖可跨批次，但**每批领用不超过可用张数**且**只能分给允许的帖**，系统以**最大流**求**总缺口最小（= 总领用最大）**的分配（例如两帖各需 10 张、通用批与仅供第 1 帖的批各 10 张时，专用批自动留给第 1 帖、通用批分给第 2 帖，两帖均无缺口）；页面逐帖列出各批次领用与缺口、逐批列出领用合计与剩余张数，导出 JSON 的 `stockBatches` 段附带相同数据；
- 画布**逐张显示**纸面、页码、空白页位与翻转方向示意；
- 一键**导出拼版清单 JSON**（包含适配检查、试印核验、印刷备料、采购报价组合、双版本共版印刷清单与库存批次领纸结果）。

## 快速开始（Docker Compose 一键启动）

```bash
docker compose up --build
```

启动后浏览器访问：**http://localhost:8080**

（停止服务：`Ctrl + C`；后台运行：`docker compose up --build -d`；移除容器：`docker compose down`。）

## 本地开发

```bash
npm install
npm start          # 启动服务，默认 8080 端口（可用 PORT 环境变量覆盖）
npm test           # 运行拼版逻辑单元测试
```

## 拼版规则说明

- **帖与张**：一帖由若干张纸叠放对折而成，每张纸正反面各印 2 页，故每帖页数 = 每帖张数 × 4。
- **页码配对**：同一帖内由外向内，第 i 张纸的正面为「最大未排页 + 最小未排页」，背面为与其相邻的两页。
- **装订方向**：
  - 左装订：第 1 页在正面右页位（书脊在左）；
  - 右装订：镜像，第 1 页在正面左页位（书脊在右）。
- **双面翻转（背面坐标变换，纸张坐标系与正面同视角）**：
  - 长边翻转：绕水平长边翻转，`(x, y) → (x, H − y)`，背面左右页位不变，内容旋转 180°（页首朝下）；
  - 短边翻转：绕垂直短边翻转，`(x, y) → (W − x, y)`，背面左右页位互换，内容方向不变。
- **阅读顺序校验**：画布上每个背面页位都标注了它物理上位于哪一正面页之背（页码首尾相接）。

### 均衡分帖（balanced split）

表单勾选「均衡分帖」（API 传 `balancedSplit: true`）后启用；不勾选 / 不传 / 传 `false` 时为**固定分帖**，结果与旧版本完全一致。

规则（`N` = 成品页数，`S` = 每帖张数上限）：

- 每帖容量仍为 `4S` 页，故**最少帖数** `k = ceil(N / 4S)`，与固定分帖的帖数相同；
- 整本所需纸张 `T = ceil(N / 4)` 在 `k` 帖间均匀分配：每帖 `floor(T/k)` 或 `ceil(T/k)` 张，**各帖实际张数差不超过 1**（多出的帖依次靠前分配），且任何一帖都不超过上限 `S`；
- 各帖按自身页数**连续编号**，页码范围首尾相接；空白页只补在末帖（页码最大的若干页位，即末帖外层高号页与其背面），**前面各帖均无空白页**；
- 每帖返回 `actualSheetCount` / `actualPageCount` / `blankPages` 与该帖的 `sheetCompensationMm`；
- 顶层汇总 `balanced`：`fixedPaddedPages`（固定分帖补白后页数）、`savedBlankPages = fixedPaddedPages − paddedPages`（相对固定分帖节省的空白页数）、`actualSheetCounts`（各帖实际张数）等；
- 爬移补偿按**该帖实际层数**（实际张数）由外向内独立重算；顶层 `creep.sheetCompensationMm` 仍按每帖张数上限给出，各帖以自身的 `sheetCompensationMm` 为准。

示例：17 页、每帖上限 2 张（8 页/帖）时，固定分帖为 `[8, 8, 8] = 24` 页、补 7 个空白页；均衡分帖为 `[2, 2, 1]` 张、`[8, 8, 4] = 20` 页，空白页仅 3 个且全部在末帖，`savedBlankPages = 4`。

### 章节优先分帖（chapter-first split）

表单勾选「章节优先分帖」并填写递增的章节起始页（API 传 `chapterSplit: true` + `chapterStarts: [...]`）后启用；与均衡分帖**互斥**（同时启用返回 400）。不勾选 / 不传 / 传 `false` 时为固定或均衡分帖，结果与旧版本完全一致（`chapterStarts` 被忽略）。

规则（`N` = 成品页数，`S` = 每帖张数上限）：

- **章节起始页**：严格递增的整数数组，取值范围 `1 ~ N`；首个起始页不为 1 时自动补上（第 1 章从第 1 页开始）。非法（非数组 / 空数组 / 非整数）、重复、未递增或越界的起始页都会返回明确错误；
- **约束**：每帖纸张数为整数（帖内页数为 4 的倍数）且不超过 `S` 张；帖内补白只允许出现在**章节末尾**（或全书末尾），章节中间断开时该帖必须恰好排满整数张；
- **优化目标**（按优先级逐项比较，保证唯一方案）：
  1. **章节被拆分次数最少**（一帖结尾落在章节中间计 1 次拆分）；
  2. **补白页总数最少**；
  3. **帖数最少**；
  4. **前帖优先装满**（前三项均并列时，让更靠前的帖容纳更多真实页）；
- **页码连续性**：章末帖内补白不占用页码，后续真实页码保持连续并正确进入下一帖；跨帖页码范围首尾相接；
- 每帖返回 `chapters`（本帖覆盖的章节及其页码范围）、真实页范围 `pageStart` / `pageEnd` 与 `blankPages`（补白位于本帖末尾的页位，页位对象中 `blank: true`）；顶层 `chapters` 汇总章节列表、拆分次数 `splitCount`、被拆分章节 `splitChapters` 与各帖实际张数 `actualSheetCounts`；
- 爬移补偿按各帖实际层数独立重算；适配检查照常逐页位执行（含章末补白页位）。

示例：20 页、每帖上限 2 张、章节起始页 `[1, 9, 14, 18]`（章 1–8 / 9–13 / 14–17 / 18–20）时，方案为 `[1–8]`、`[9–13]+3 页补白`、`[14–20]+1 页补白`，共 3 帖、0 次拆分、4 页补白；第 14 页正确进入第 3 帖首页。

顶层 `chapters` 汇总示例：

```json
{
  "enabled": true,
  "starts": [1, 9, 14, 18],
  "count": 4,
  "list": [
    { "index": 1, "pageStart": 1, "pageEnd": 8 },
    { "index": 2, "pageStart": 9, "pageEnd": 13 },
    { "index": 3, "pageStart": 14, "pageEnd": 17 },
    { "index": 4, "pageStart": 18, "pageEnd": 20 }
  ],
  "splitCount": 0,
  "splitChapters": [],
  "maxSheetsPerSignature": 2,
  "actualSheetCounts": [2, 2, 2]
}
```

### 爬移补偿（creep compensation）

骑马钉装订时内层纸页在书背处被向外推出，折页裁切后内层页会比外层短，需要把内层页位向切口方向平移补偿。表单中的两个可选参数（均为 mm）：

- **纸张厚度** `paperThickness`：单张纸的厚度；
- **最大补偿量** `maxCompensation`：单张纸补偿量的封顶值。

规则：

- 每帖第 `i` 张纸由外向内以 `0` 起算，补偿量 = `min(i × 纸张厚度 × 2, 最大补偿量)`（一张纸在折缝两侧各贡献一个厚度，故乘 2；各帖独立从 `i = 0` 起算）；
- 偏移符号：**左装订时左页位取正、右页位取负**；**右装订时符号整体反转**（左负右正）；
- 偏移与双面翻转方式无关，正、背面同方向平移；
- 每个页位（包括自动补齐的**空白页**）都输出 `offsetMm`；
- **纸张厚度或最大补偿量任一为 0（或缺省）时，所有 `offsetMm` 为 0，页码拼版结果与不启用时完全一致**（向后兼容）。

画布上橙色**虚线框**表示补偿前的原始页位，橙色**实线框**表示补偿后页位；画布位移为示意性放大（非真实 mm 等比），精确数值以清单和导出 JSON 中的 `offsetMm` 为准。

### 纸张规格与出血 / 安全区适配检查

表单中可选填写（均为 mm）：**纸张宽 / 高**、**成品页宽 / 高**、**出血**、**安全边距**。四项尺寸全部留空（或为 0）时不检查，行为与旧版本完全一致；一旦填写其中任意一项，四项尺寸必须全部大于 0，出血与安全边距缺省为 0。

检查规则（纸张坐标系，与正面同一视角）：

- 每个页位的**可用矩形**为纸张的一半：左页位 `[0, W/2] × [0, H]`，右页位 `[W/2, W] × [0, H]`；背面页位与正面共用同一坐标系（长边翻转左右不变、短边翻转左右互换），每个页位同时返回内容方向 `rotation`（长边翻转的背面为 180°，其余为 0°）；
- 成品页在页位内**居中放置**，并叠加该页位的爬移偏移 `offsetMm`，得到裁切框 `trim`；
- **出血框** `bleedBox` = `trim` 四边各外扩出血，必须完全落在纸张矩形内（折线一侧的出血进入相邻页位属正常工艺，仅纸张外边界构成约束）；
- **安全区** `safeBox` = `trim` 四边各内缩安全边距；`2 × 安全边距` 超过成品页宽 / 高时安全区不存在，记为超限。

每个页位（含空白页）输出 `fit`：`{ ok, rotation, rect, trim, bleedBox, safeBox, violations }`，`violations` 逐条给出超限原因（`page-too-wide` / `page-too-tall` / `bleed-overflow-{left,top,right,bottom}` / `safety-too-wide` / `safety-too-tall`，含具体超出量）；顶层 `fit` 汇总 `ok / totalSlots / failCount`。画布上蓝框 = 裁切线、绿/红虚框 = 出血范围（红 = 超出纸张）、灰点框 = 安全区，不合格页位带红色圆徽，清单对应单元格标红并列出原因。

### 双面生产标记（duplex production marks）

勾选表单中的「双面生产标记」（API 传 `productionMarks: true`，可用 `markSizeMm` 指定尺寸，缺省 5mm、最大 100mm）后启用；**必须先启用适配检查**（标记坐标取自 `trim` / `bleedBox`），未提供纸张与成品页尺寸时勾选会返回 400。缺省 / 不传 / 传 `false` 时结果与旧版本完全一致（不带任何标记字段）。

每张纸的正、背面各放置三类标记（均为水平 / 竖直线段，纸张坐标系 mm）：

- **裁切线 `crop`**：四个成品页外角（左页位左上 / 左下、右页位右上 / 右下），每角一段水平线（`crop-{tl,tr,br,bl}-h`）与一段竖直线（`-v`），共 8 条；起点在出血框外固定间隙 2mm 处，向最近的纸边方向延伸 `markSizeMm`；
- **折线标 `fold`**：纸张中线（折线 / 订口）上、下两端各一段自纸边向内的竖线（`fold-top` / `fold-bottom`）；
- **套准十字 `register`**：左、右两侧出血框外各一个十字（一横一竖两条线段），十字中心在出血框外 2mm；每侧按固定候选位置顺序 **① 出血框垂直居中 → ② 四分之一高度 → ③ 四分之三高度** 依次尝试，第一条候选的两条线段全部合法才落位（输出 `position` 1/2/3）。

落位规则（按候选位置固定顺序尝试，输出唯一确定）：

1. 每条线段必须**完整落在纸张矩形内**（端点可贴纸张边缘），否则该候选记 `segment-outside-paper`；
2. 线段不得与本面两侧出血框**正长度相交**（仅端点 / 边界相接不算），否则记 `segment-hits-bleed-box`；
3. 线段不得与同一面**已放置标记**相交（放置顺序：裁切线左上 → 右上 → 右下 → 左下，每角先水平后竖直 → 折线标上 → 下 → 套准十字左 → 右），否则记 `segment-hits-mark`。

同一面放置顺序固定为：裁切线 → 折线标 → 套准十字；一个标记的全部候选位置都不可用时**省略**该标记，并在 `omitted` 中逐候选返回 `attempts`（位置编号、是否可用、逐线段原因代码与说明）、`reasonCode`（最后一个候选的首条原因）、`reasonSummary` 与完整 `reason`。

**正背套准（背面坐标变换）**：背面不在背面视角独立排版，而是对正面已放置标记的每条线段按翻转方式做同一物理位置的坐标变换——

- 长边翻转：`(x, y) → (x, H − y)`（绕水平长边翻转）；
- 短边翻转：`(x, y) → (W − x, y)`（绕垂直短边翻转）。

因此正、背面标记在纸张上的物理位置完全重合（翻面后对齐套准）；正面因无可用位置省略的标记，背面在同一物理位置**同步省略**（`reasonCode: 'paired-front-omitted'`，`pairedWith` 指向正面同名标记）。标记坐标取自含爬移偏移的 `trim` / `bleedBox`，**纸张尺寸、出血或爬移参数变化时所有标记在同一次重算中同步重算**。

前端画布按纸张 mm 等比绘制全部已放置标记：黑色实线 = 裁切线、玫红虚线 = 折线标、青色 = 套准十字；逐张在画布下方与清单「备注」列给出省略提示（悬停查看逐候选原因），张导航标注「省略标记 N」；导出 JSON 包含每个标记的线段坐标与省略原因。空白页纸张同样生成标记。

`productionMarks` 段示例（每张纸 `sheet.productionMarks`，节选）：

```json
{
  "front": {
    "placed": [
      {
        "id": "crop-tl-h",
        "type": "crop",
        "label": "左上角水平裁切线",
        "position": 0,
        "positionLabel": "左上角（固定位置）",
        "side": "front",
        "segments": [{ "x1": 5, "y1": 16.5, "x2": 0, "y2": 16.5 }]
      },
      {
        "id": "register-left",
        "type": "register",
        "label": "左侧套准十字",
        "position": 1,
        "positionLabel": "出血框垂直居中",
        "side": "front",
        "segments": [
          { "x1": 5, "y1": 165, "x2": 0, "y2": 165 },
          { "x1": 5, "y1": 162.5, "x2": 5, "y2": 167.5 }
        ]
      }
    ],
    "omitted": [
      {
        "id": "register-right",
        "type": "register",
        "label": "右侧套准十字",
        "side": "front",
        "reasonCode": "segment-outside-paper",
        "reasonSummary": "线段超出纸张边界（标记无法完整落在纸内）",
        "reason": "候选位置 1「出血框垂直居中」：线段超出纸张边界… ｜ 候选位置 2… ｜ 候选位置 3…",
        "attempts": [
          { "position": 1, "positionLabel": "出血框垂直居中", "ok": false,
            "checks": [{ "segmentIndex": 0, "code": "segment-outside-paper", "message": "线段超出纸张边界（标记无法完整落在纸内）" }] }
        ]
      }
    ]
  },
  "back": {
    "placed": [
      { "id": "register-left", "type": "register", "side": "back", "pairedWith": "register-left",
        "transform": { "flip": "short", "mapping": "(x, y) -> (W - x, y)" },
        "segments": [{ "x1": 455, "y1": 165, "x2": 460, "y2": 165 }, { "x1": 455, "y1": 162.5, "x2": 455, "y2": 167.5 }] }
    ],
    "omitted": []
  }
}
```

顶层 `productionMarks` 汇总：`{ enabled, markSizeMm, gapMm, paperWidth, paperHeight, flip, transform, placedCount, omittedCount, sheets[] }`，其中 `sheets[]` 逐张给出正 / 背面的 `placedCount` / `omittedCount`；未启用时仅为 `{ "enabled": false }`。

### 试印核验（trial print verification）

生成拼版后，可在逐张预览旁对照实物纸张录入 **1～12 条观察**：帖、张、正/背面、左/右页位、看到的页码（或空白）以及内容朝向（正向 / 倒置 180°）。点击「开始核验」（已核验过时增删观察会自动重核）后，服务端用**同一输入**分别重算「左/右装订 × 长/短边翻转」四种设置，逐条比对：

- **页码 / 空白**：观察为空白时期望页位必须为空白；观察为页码时必须与期望页码一致；
- **内容朝向**：仅当观察与期望页位均非空白时比对（空白页无内容朝向，记为跳过）；正面恒为正向，背面长边翻转为倒置、短边翻转为正向。

每种设置统计**错误观察数**（任一字段不符即计）与**错误字段总数**，四种候选按「**错误观察数最少 → 错误字段数最少 → 当前设置优先 → 固定组合顺序**（左/短、左/长、右/短、右/长）」排序，结论分三种：

- **验证通过（`verified`）**：存在**唯一零差异组合**——若即当前设置则确认无误；若是其他组合，说明实物唯一对应另一组设置，结论中明确标出；
- **无法判定（`undetermined`）**：**并列最优**（含多个零差异组合，例如只做正面观察无法区分长/短边翻转）——返回全部并列组合，**不强行推荐**，需补充更有区分度的观察；服务端同时从未观察页位计算**下一处观察建议**（见下）；
- **验证未通过（`failed`）**：四种设置均有差异——给出最接近的组合及其差异数。

#### 下一处观察建议（next suggestion）

结论为无法判定时，服务端遍历所有**尚未观察**的页位，取各并列组合在该页位的预期结果（页码 / 空白 + 内容朝向），预期相同的组合归为一组——实物在该页位看到哪一组结果，就只剩该组的候选组合。全部页位按以下优先级逐项比较（全并列时仍保证唯一建议）：

1. **最坏情况下剩余候选数最少**（最大结果组的大小最小）——首要目标；
2. **可形成的结果分组数最多**（同样最坏剩余时区分更细）；
3. **非空白优先**（并列组合中预期该页位为空白的个数最少；空白页位对页码与朝向均无信息）；
4. **背面优先**（正面朝向恒为正向，只有背面能区分长 / 短边翻转）；
5. **帖号靠前 → 张号靠前 → 左页位优先**。

若所有未观察页位在各并列组合下的预期都完全一致（如 1 页册子无法区分长 / 短边翻转），则**明确返回无建议**（`nextSuggestion` 为 `null`，结论消息说明剩余页位均无法继续区分）。`verified` / `failed` 结论不出建议；无观察时流程不变。

建议对象含：定位（`signature` / `sheet` / `side` / `position`）、各并列候选的预期值 `candidates`（`binding` / `flip` / `blank` / `page` / `orientation`，按固定组合顺序）、结果分组 `outcomeGroups`（每组的预期值与落入该组的组合）、`groupCount` 与 `worstRemainingCandidates`。建议随观察增删在每次重算时同步刷新，且一定不指向已观察页位。

前端在无法判定横幅下展示建议框与**「查看建议」**按钮，点击跳到对应纸张并以青色框高亮建议页位；分组列出各候选预期（页码 / 空白 + 朝向）；增删观察或重新生成后建议同步刷新（已无建议时明确提示）。点击差异行（或观察列表中的条目）仍可跳到对应纸张并高亮页位；「导出拼版清单 JSON」中包含 `verification`（观察、候选评分、结论与 `nextSuggestion`）。非法索引（帖 / 张越界）、重复观察（同一帖 / 张 / 面 / 页位）与非法字段值都会返回 400 明确错误；不录入观察时流程与之前完全一致。

### 印刷备料（printing material preparation）

勾选表单中的「印刷备料」并填写以下参数后启用（API 传 `materialPrep: { copies, makereadySheets, processWasteRate, sheetsPerPack }`）；缺省 / 不传 / `null` / `false` / `{ "enabled": false }` 时**不启用，响应中不含任何备料字段，与旧版本完全一致**。

- **成品份数** `copies`：≥ 1 的整数（每份成品需要每帖全部纸张各一张）；
- **每帖开机损耗张数** `makereadySheets`：≥ 0 的整数，**每个帖分别加一次**（各帖独立开机校机）；
- **过程损耗率** `processWasteRate`：0 ≤ r < 1 的小数，`0.03` 表示 3%（表单按百分数填写，自动除以 100 上送）；
- **每包张数** `sheetsPerPack`：≥ 1 的整数，最终采购量按整包向上取整。

计算**按帖独立进行，逐帖取整后再汇总**（核心约束：禁止先合并各帖再计算损耗）：

1. **净用纸（帖）** = 该帖实际张数（固定 / 均衡 / 章节优先分帖下均取 `actualSheetCount`，含补白纸）× 成品份数；
2. **需领纸（帖）** = `ceil((净用纸 + 开机损耗) / (1 − 过程损耗率))`，每个帖**分别**向上取整；
3. **过程损耗（帖）** = 需领纸 − 净用纸 − 开机损耗（≥ 0，含该帖的取整余量）；
4. **汇总** = 各帖净用纸 / 开机损耗 / 过程损耗 / 需领纸分别相加；
5. **整包采购** = 采购包数 `ceil(需领纸合计 / 每包张数)`，采购张数 = 包数 × 每包张数，包余 = 采购张数 − 需领纸合计。

> 逐帖 `ceil` 后汇总通常比「合并后再算一次」多领纸（各帖取整余量之和），这是工艺要求——各帖独立开机、独立损耗管控，系统不会跨帖平摊。

示例：16 页、每帖 2 张（2 帖各 2 张）、1000 份、每帖开机损耗 10 张、过程损耗率 3%、每包 500 张：

- 每帖净用纸 `2 × 1000 = 2000`，需领纸 `ceil(2010 / 0.97) = 2073` 张，过程损耗 63 张；
- 汇总：净用纸 4000 + 开机损耗 20 + 过程损耗 126 = **需领纸 4146 张**（若先合并：`ceil(4010/0.97) = 4135`，少 11 张，被明确禁止）；
- 整包采购：`ceil(4146 / 500) = 9` 包 × 500 = **4500 张**，包余 354 张。

顶层 `materialPrep` 段示例：

```json
{
  "enabled": true,
  "copies": 1000,
  "makereadySheets": 10,
  "processWasteRate": 0.03,
  "sheetsPerPack": 500,
  "formula": "requiredSheets = ceil((netSheets + makereadySheets) / (1 - processWasteRate))，逐帖取整后汇总",
  "signatures": [
    { "signature": 1, "actualSheetCount": 2, "copies": 1000,
      "netSheets": 2000, "makereadySheets": 10, "processWaste": 63, "totalWaste": 73, "requiredSheets": 2073 }
  ],
  "totals": {
    "signatureCount": 2,
    "netSheets": 4000,
    "makereadySheets": 20,
    "processWaste": 126,
    "totalWaste": 146,
    "requiredSheets": 4146,
    "purchasePacks": 9,
    "sheetsPerPack": 500,
    "purchaseSheets": 4500,
    "packRemainder": 354
  }
}
```

前端结果区「**印刷备料**」面板逐帖列出每帖实际张数、净用纸、开机损耗、过程损耗、损耗合计与需领纸，底部汇总行给出合计，顶部 chips 给出需领纸合计与整包采购（包数 / 张数 / 包余）；导出的拼版清单 JSON 含同一 `materialPrep` 段。备料只读取拼版结果中各帖的实际张数，固定 / 均衡 / 章节优先分帖均可启用，不影响页码拼版本身。

### 采购报价组合（purchase quote combination）

勾选表单中的「采购报价组合」并录入 1～8 条本地报价后启用（API 传 `purchaseQuotes: { demandSheets?, quotes: [...] }`）；缺省 / 不传 / `null` / `false` / `{ "enabled": false }` 时**不启用，响应中不含任何报价组合字段，与旧版本完全一致**。

- **需求张数** `demandSheets`（**可选**）：≥ 1 的整数。**缺省时自动接入印刷备料汇总后的整包采购张数**（`materialPrep.totals.purchaseSheets`）；未启用备料且未填写需求张数时返回 400 明确错误。表单中不勾选「手工填写需求张数」即取备料整包采购张数，勾选后可手工覆盖。
- 每条 **报价** `quotes[]`：
  - `supplier`：供应商名称（非空字符串，≤ 50 字符，同次请求内不可重复）；
  - `sheetsPerPack`：每包张数（≥ 1 的整数）；
  - `pricePerPackCents`：每包价格，**以分为单位的非负整数**（如 `1234` = 12.34 元；表单按元填写、最多两位小数，提交时用整数运算精确换算为分，全程不做浮点比较）；
  - `minPacks`：最少可购包数（≥ 0 的整数，`0` = 不设下限，为强制下界）；
  - `maxPacks`：最多可购包数（≥ 1 的整数，且 ≥ `minPacks`）。

在满足 `需求张数 ≤ Σ 采购包数 × 每包张数` 与各报价 `[minPacks, maxPacks]` 边界的**全部整数包组合**中，系统按以下优先级逐项比较确定**唯一方案**：

1. **总价最低**（`Σ 采购包数 × 每包价格（分）` 最小，整数比较）；
2. **超购张数最少**（采购总张数 − 需求张数最小）；
3. **供应商数量最少**（实际采购包数 > 0 的报价条数最少）；
4. **录入顺序**（前三项均并列时，从第 1 条报价起逐条比较，让录入更早的报价采购更多包数——与章节优先分帖「前帖优先装满」同一原则）。

> 最优解采购张数不可能达到「需求 + 最大每包张数」或更多（此时必可删掉某个至少 1 包的报价而仍满足需求，且总价不增）。求解器为双引擎：需求窗口（缺口 + 最大包型）较小时用**稠密数组余数滑动窗口最小值动态规划**（typed array 存储，窗口顺序键用 BigInt 整数 cross-product 比较，录入顺序向量按精确 double 分量字典序比较，回溯方案）；需求大而包型也大（真实印刷包型 250～520 张/包、需求上千万）时切换为**枚举引擎**——取每分单价最便宜（cross-product 比较，同价取录入最早）的报价为整包兜底供应商，DFS 其余报价在窗口内的采购量、叶节点由兜底整包补足，每节点用「每张 cross-product 金额下界」剪枝。金额全程整数分，绝不做浮点比较；两引擎均内置随机全枚举暴力对照测试（稠密 4000 组 + 枚举 300 组大需求实例）。极端退化输入（极小包型 + 极大需求且各报价单价相同导致两引擎均无法在预算内收敛）返回 400 明确错误而非超时或内存溢出。

**无可行组合**（即使所有报价都按上限采购仍凑不满需求）时 HTTP 仍返回 200，`purchaseQuotes.feasible` 为 `false`，并给出：

- `gapSheets`：缺口张数（需求 − 尽最大可购张数）；
- `reason`：可读说明（含最大可购张数 / 需求 / 缺口）；
- `maxPurchasableSheets` / `minPurchasableSheets`：全部报价按上限 / 下限时的张数；
- `rows[]`：按各报价**上限**给出的「尽最大可购」行（余量均为 0）与合计金额，方便直接看到每家供应商的产能边界。

顶层 `purchaseQuotes` 段示例（需求 100 张，2 条报价：A 50 张/包 500 分、B 50 张/包 400 分）：

```json
{
  "enabled": true,
  "demandSheets": 100,
  "demandSource": "manual",
  "priceUnit": "cents",
  "tieBreakRule": "总价最低 → 超购张数最少 → 供应商数量最少 → 录入顺序（更早录入优先装满）",
  "quotes": [
    { "index": 1, "supplier": "A", "sheetsPerPack": 50, "pricePerPackCents": 500, "minPacks": 0, "maxPacks": 10 },
    { "index": 2, "supplier": "B", "sheetsPerPack": 50, "pricePerPackCents": 400, "minPacks": 0, "maxPacks": 10 }
  ],
  "feasible": true,
  "demandSheets": 100,
  "tieBreak": "totalCostCents -> overPurchaseSheets -> supplierCount -> entryOrder",
  "totals": {
    "totalPacks": 2,
    "totalSheets": 100,
    "overPurchaseSheets": 0,
    "totalCostCents": 800,
    "supplierCount": 1,
    "suppliers": ["B"]
  },
  "rows": [
    { "index": 1, "supplier": "A", "sheetsPerPack": 50, "pricePerPackCents": 500,
      "minPacks": 0, "maxPacks": 10, "packs": 0, "sheets": 0, "amountCents": 0,
      "remainingPacks": 10, "remainingSheets": 500 },
    { "index": 2, "supplier": "B", "sheetsPerPack": 50, "pricePerPackCents": 400,
      "minPacks": 0, "maxPacks": 10, "packs": 2, "sheets": 100, "amountCents": 800,
      "remainingPacks": 8, "remainingSheets": 400 }
  ]
}
```

前端结果区「**采购报价组合**」面板顶部显示需求张数与来源（手工 / 备料接入），逐报价列出每包张数、每包价格、最少 / 最多包数、**采购包数 / 采购张数 / 采购金额 / 余量**，底部汇总行给出采购包数 / 张数 / 总价（元）与超购或缺口；不可行时以红色横幅显示具体缺口，表格按各报价上限展示尽最大可购量。导出的拼版清单 JSON 含同一 `purchaseQuotes` 段。

### 双版本共版印刷（dual-version shared-plate printing）

同一本书的 A、B 两个版本只有少量页面不同时，无需为两版各出全套印版。勾选表单中的「双版本共版印刷」并填写以下参数后启用（API 传 `dualVersion: { copiesA, copiesB, changedPages }`）；缺省 / 不传 / `null` / `false` / `{ "enabled": false }` 时**不启用，响应中不含任何共版字段，与旧版本完全一致**。

- **A 版成品份数** `copiesA` / **B 版成品份数** `copiesB`：均为 ≥ 1 的整数；
- **B 版改动页码** `changedPages`：B 版相对 A 版改动的**真实页码**，支持单页与区间混合输入——
  - 表单直接填写文本，如 `3, 5-8, 12`（逗号 / 顿号 / 分号 / 空白分隔，区间连字符支持 `- – — ~`，连字符两侧可有空格）；
  - API 可传字符串 `"3, 5-8"`，或数组 `[3, "5-8", { "start": 10, "end": 12 }]`；
  - 服务端**自动去重并升序**，逐页校验范围为 `1 ~ totalPages` 的整数，区间起点不得大于终点；启用时至少要有 1 个改动页，非法条目返回 400 明确错误。

判定规则（**沿用当前分帖、补白、装订与翻转后的页位**，逐张逐面独立判定）：

- **无改动页的面**：A、B 两版该面内容完全相同，**共用一块印版**，印次 = `copiesA + copiesB`；
- **含改动页的面**：**拆成 A、B 两块印版**，A 版印 `copiesA` 次、B 版印 `copiesB` 次；
- **同一张纸的正、背面独立判定**（正面含改动页不代表背面需要拆版，反之亦然）；
- 补白的空白页位不属于任何版本内容，不参与改动判定（含空白页的面只要无改动页仍共版）。

> 共版节省的是**印版**而非纸张：无论是否共版，每个面的总印次都是 `copiesA + copiesB`（纸用量不变）；无改动的面从「A、B 各一块版」省为「共用一块版」，`savedPlateCount` 即相对全部拆版节省的印版数。

示例：16 页、每帖 2 张（2 帖各 2 张）、A 版 1000 份、B 版 500 份、改动页 `3, 5-8`（去重后 5 页，全部落在第 1 帖）——第 1 帖 4 个面全部拆版（各 A、B 两块），第 2 帖 4 个面全部共版（各 1 块、印次 1500）；印版合计 12 块（较全部拆版节省 4 块），总印次 12000。

顶层 `dualVersion` 段示例（节选）：

```json
{
  "enabled": true,
  "copiesA": 1000,
  "copiesB": 500,
  "changedPages": [3, 5, 6, 7, 8],
  "changedPageCount": 5,
  "rule": "逐张逐面判定：无改动页的面共用一块印版（印次 = A + B），含改动页的面拆成 A、B 两块印版（各按自身份数印刷），同张纸正背面独立判定",
  "rows": [
    { "signature": 1, "sheet": 1, "side": "front", "leftPage": 8, "rightPage": 1,
      "changedPages": [8], "shared": false,
      "plates": [ { "plate": "A", "impressions": 1000 }, { "plate": "B", "impressions": 500 } ] },
    { "signature": 2, "sheet": 1, "side": "front", "leftPage": 16, "rightPage": 9,
      "changedPages": [], "shared": true,
      "plates": [ { "plate": "shared", "impressions": 1500 } ] }
  ],
  "totals": {
    "sideCount": 8,
    "sharedSideCount": 4,
    "splitSideCount": 4,
    "sharedPlateCount": 4,
    "splitPlateCount": 8,
    "plateCount": 12,
    "savedPlateCount": 4,
    "impressions": 12000
  }
}
```

前端结果区「**双版本共版印刷**」面板逐面列出帖 / 张 / 面 / 左右页位页码 / 本面改动页 / 印版归属（共用 1 块或拆 A、B 两块）/ 印次，拆版面以底色标出，底部汇总行给出面数、印版总数与总印次；顶部 chips 给出两版份数、改动页数、共版 / 拆版面数、印版合计与节省印版数。导出的拼版清单 JSON 含同一 `dualVersion` 段。共版判定只读取拼版结果的页位，固定 / 均衡 / 章节优先分帖均可启用，不影响页码拼版本身。

### 库存批次领纸（inventory batch paper drawing）

勾选表单中的「库存批次领纸」并录入 1～12 个库存批次后启用（API 传 `stockBatches: { batches: [...] }`）；缺省 / 不传 / `null` / `false` / `{ "enabled": false }` 时**不启用，响应中不含任何批次领纸字段，与旧版本完全一致**。

**前置条件：必须先启用印刷备料**（`materialPrep`）——各帖需求直接取自备料结果 `materialPrep.signatures[].requiredSheets`（已含开机损耗与过程损耗率的逐帖取整），未启用备料时启用本模块返回 400 明确错误。

- 每个 **批次** `batches[]`（1～12 个）：
  - `lot`：批号（非空字符串，≤ 50 字符，**同次请求内不可重复**）；
  - `availableSheets`：可用张数（≥ 1 的整数）；
  - `allowedSignatures`（**可选**）：允许使用的帖号数组（1 ~ 实际帖数的整数，同批内不可重复）；**缺省 / `null` / 空数组 = 通用批（全部帖可用）**。

分配规则与求解：

- **批次可拆给多帖、同帖可跨批次**（分配单位为整张纸）；
- **每批领用合计不得超过其可用张数**（库存约束），**每批只能分给允许使用的帖**；
- 优化目标为**总缺口最小**：总缺口 = Σ（各帖需领纸 − 各帖实际领用），等价于总领用最大。建模为最大流求解（源 → 批次容量 = 可用张数，批次 → 允许的帖容量无限，帖 → 汇容量 = 需领纸），同一输入必得同一分配（确定性输出）。

> 为什么需要最大流而不是顺序贪心：两帖各需 10 张，一个通用批（10 张）与一个仅供第 1 帖的批（10 张）时，若通用批先分给第 1 帖，专用批将无处可去、第 2 帖缺 10 张；最大流会自动**重路由**——专用批留给第 1 帖、通用批分给第 2 帖，两帖均无缺口。

示例：8 页、每帖 1 张（2 帖各 1 张）、份数 10、无损耗（每帖需领纸 10 张），批次 `ALL`（通用，10 张）与 `S1`（仅第 1 帖，10 张）：

```json
{
  "enabled": true,
  "demandSource": "materialPrep.requiredSheets",
  "batches": [
    { "index": 1, "lot": "ALL", "availableSheets": 10, "universal": true, "allowedSignatures": null,
      "drawnSheets": 10, "remainingSheets": 0, "allocations": [{ "signature": 2, "sheets": 10 }] },
    { "index": 2, "lot": "S1", "availableSheets": 10, "universal": false, "allowedSignatures": [1],
      "drawnSheets": 10, "remainingSheets": 0, "allocations": [{ "signature": 1, "sheets": 10 }] }
  ],
  "signatures": [
    { "signature": 1, "requiredSheets": 10, "drawnSheets": 10, "gapSheets": 0,
      "allocations": [{ "batch": 2, "lot": "S1", "sheets": 10 }] },
    { "signature": 2, "requiredSheets": 10, "drawnSheets": 10, "gapSheets": 0,
      "allocations": [{ "batch": 1, "lot": "ALL", "sheets": 10 }] }
  ],
  "totals": {
    "signatureCount": 2, "batchCount": 2,
    "requiredSheets": 20, "availableSheets": 20,
    "drawnSheets": 20, "remainingSheets": 0,
    "gapSheets": 0, "fullyCovered": true
  }
}
```

**库存不足不是错误**：响应仍为 200，`totals.fullyCovered` 为 `false`，逐帖 `gapSheets` 给出缺口、逐批 `remainingSheets` 给出剩余（受帖号限制而无法用出的库存会如实剩余）。

前端结果区「**库存批次领纸**」面板分两张表：**逐帖**列出需领纸、各批次领用明细、领用合计与缺口（缺口行标红，顶部红色横幅提示总缺口）；**逐批**列出可用张数、允许帖号、领用合计、**剩余张数**与领用去向。导出的拼版清单 JSON 含同一 `stockBatches` 段。重复批号、无效帖号（非整数 / 超出帖数范围 / 同批重复）、批次数量越界（< 1 或 > 12）、可用张数非法，以及未启用备料时启用本模块，均返回 400 明确错误。


## API

### `POST /api/impose`

请求体：

```json
{
  "totalPages": 16,
  "sheetsPerSignature": 2,
  "balancedSplit": false,
  "chapterSplit": false,
  "chapterStarts": [],
  "binding": "left",
  "flip": "short",
  "paperThickness": 0.1,
  "maxCompensation": 2,
  "paperWidth": 440,
  "paperHeight": 310,
  "pageWidth": 210,
  "pageHeight": 297,
  "bleedMm": 3,
  "safetyMm": 5,
  "productionMarks": true,
  "markSizeMm": 5,
  "observations": [
    { "signature": 1, "sheet": 1, "side": "front", "position": "right", "page": 1, "orientation": "upright" },
    { "signature": 1, "sheet": 1, "side": "back", "position": "left", "page": null, "orientation": "upright" }
  ],
  "materialPrep": {
    "copies": 1000,
    "makereadySheets": 10,
    "processWasteRate": 0.03,
    "sheetsPerPack": 500
  },
  "purchaseQuotes": {
    "demandSheets": 4500,
    "quotes": [
      { "supplier": "华泰纸行", "sheetsPerPack": 500, "pricePerPackCents": 9800, "minPacks": 0, "maxPacks": 20 },
      { "supplier": "恒丰纸业", "sheetsPerPack": 500, "pricePerPackCents": 9500, "minPacks": 0, "maxPacks": 20 }
    ]
  },
  "dualVersion": {
    "copiesA": 1000,
    "copiesB": 500,
    "changedPages": [3, "5-8"]
  },
  "stockBatches": {
    "batches": [
      { "lot": "A01", "availableSheets": 3000 },
      { "lot": "B02", "availableSheets": 1500, "allowedSignatures": [1, 2] }
    ]
  }
}
```

- `totalPages`：成品页数，1 ~ 10000 的整数
- `sheetsPerSignature`：每帖张数上限，1 ~ 100 的整数
- `balancedSplit`：**可选**，`true` 启用均衡分帖（在最少帖数间均匀分配纸张，各帖实际张数差 ≤ 1，空白页只留在末帖末尾）；缺省 / `false` 为固定分帖（向后兼容）
- `chapterSplit`：**可选**，`true` 启用章节优先分帖（与均衡分帖互斥）；缺省 / `false` 时 `chapterStarts` 被忽略，结果与旧版本完全一致
- `chapterStarts`：启用章节优先分帖时**必填**，严格递增的章节起始页数组（整数，1 ~ totalPages；首个不为 1 时自动补上第 1 章）；非法、重复、未递增或越界均返回 400 明确错误
- `binding`：`left`（左装订）或 `right`（右装订）
- `flip`：`long`（长边翻转）或 `short`（短边翻转）
- `paperThickness`：**可选**，纸张厚度（mm，≥ 0，缺省为 0）
- `maxCompensation`：**可选**，爬移最大补偿量（mm，≥ 0，缺省为 0）
- `paperWidth` / `paperHeight` / `pageWidth` / `pageHeight`：**可选**，纸张与成品页宽高（mm）；全部缺省或为 0 时不做适配检查，提供任意一项则四项必须全部 > 0
- `bleedMm` / `safetyMm`：**可选**，出血与安全边距（mm，≥ 0，缺省为 0）
- `productionMarks`：**可选**，`true` 启用双面生产标记（缺省 / `false` 不启用，结果与旧版本完全一致）；启用时必须已提供四项尺寸开启适配检查，否则返回 400
- `markSizeMm`：**可选**，生产标记尺寸（mm，> 0 且 ≤ 100，缺省 5；仅启用生产标记时校验，空串 / `null` 取缺省值）
- `observations`：**可选**，试印核验观察数组（1～12 条；缺省 / 空数组不启用核验，结果与旧版本完全一致）。每条：
  - `signature` / `sheet`：帖号 / 张号（1 起始整数；张号不超过该帖实际张数）
  - `side`：`front`（正面）/ `back`（背面）；`position`：`left`（左页位）/ `right`（右页位）
  - `page`：看到的页码（1 ~ totalPages 的整数），或 `null` 表示看到空白页
  - `orientation`：`upright`（正向）/ `rotated`（倒置 180°）
  - 同一帖 / 张 / 面 / 页位的重复观察、索引越界、字段非法均返回 400 明确错误
- `materialPrep`：**可选**，印刷备料参数对象（缺省 / `null` / `false` 不启用，响应不含备料字段，与旧版本完全一致）。字段：
  - `copies`：成品份数，≥ 1 的整数；
  - `makereadySheets`：每帖开机损耗张数，≥ 0 的整数（每帖分别加一次）；
  - `processWasteRate`：过程损耗率，0 ≤ r < 1 的小数（`0.03` = 3%）；
  - `sheetsPerPack`：每包张数，≥ 1 的整数。
  - 逐帖 `ceil((净用纸 + 开机损耗) / (1 − 过程损耗率))` 后汇总，再按每包向上取整采购；参数非对象、份数 / 包数非正整数、开机损耗为负、损耗率越界（< 0 或 ≥ 1）均返回 400 明确错误。
- `purchaseQuotes`：**可选**，采购报价组合参数对象（缺省 / `null` / `false` 不启用，响应不含报价组合字段，与旧版本完全一致）。字段：
  - `demandSheets`：手工需求张数，≥ 1 的整数，**可缺省**——缺省时自动取同次请求 `materialPrep` 汇总后的整包采购张数（`totals.purchaseSheets`）；未启用备料又未填需求张数返回 400；
  - `quotes`：1～8 条报价，每条含 `supplier`（非空、不重复，≤ 50 字符）/ `sheetsPerPack`（≥ 1 整数）/ `pricePerPackCents`（每包价格，**分为单位的非负整数**，如 `1234` = 12.34 元）/ `minPacks`（≥ 0 整数）/ `maxPacks`（≥ 1 且 ≥ `minPacks` 的整数）；
  - 在满足需求与各报价边界的组合中按「总价最低 → 超购张数最少 → 供应商数量最少 → 录入顺序（更早录入优先装满）」确定唯一方案；无可行组合时响应 200 且 `purchaseQuotes.feasible` 为 `false`，附 `gapSheets` 缺口与按上限给出的尽最大可购行；
  - 报价非数组 / 为空 / 超过 8 条、供应商为空或重复、每包张数非正整数、价格为负或非整数分、包数边界非法等均返回 400 明确错误。
- `dualVersion`：**可选**，双版本共版印刷参数对象（缺省 / `null` / `false` 不启用，响应不含共版字段，与旧版本完全一致）。字段：
  - `copiesA` / `copiesB`：A 版 / B 版成品份数，均为 ≥ 1 的整数；
  - `changedPages`：B 版相对 A 版改动的真实页码，支持单页与区间——数组形式如 `[3, "5-8", { "start": 10, "end": 12 }]`，或直接给字符串 `"3, 5-8"`（逗号 / 顿号 / 分号 / 空白分隔，区间连字符支持 `- – — ~`）；自动去重并升序，每个页码必须为 1 ~ totalPages 的整数，区间起点不得大于终点，启用时至少 1 个改动页；
  - 逐张逐面判定：无改动页的面共用一块印版（印次 = A + B），含改动页的面拆成 A、B 两块印版各按自身份数印刷，同张纸正背面独立判定；
  - 参数非对象、份数非正整数、改动页缺失 / 为空 / 非整数 / 越界 / 区间倒置 / 条目无法解析等均返回 400 明确错误。
- `stockBatches`：**可选**，库存批次领纸参数对象（缺省 / `null` / `false` 不启用，响应不含批次领纸字段，与旧版本完全一致）。**启用时必须同时提供有效的 `materialPrep`**（各帖需求取自 `materialPrep.signatures[].requiredSheets`），未启用备料时启用本模块返回 400 明确错误。字段：
  - `batches`：1～12 个批次，每个含 `lot`（批号，非空、≤ 50 字符、同次请求内不可重复）/ `availableSheets`（可用张数，≥ 1 的整数）/ `allowedSignatures`（可选，允许使用的帖号数组，1 ~ 实际帖数的整数、同批内不可重复；缺省 / `null` / 空数组 = 通用批，全部帖可用）；
  - 批次可拆给多帖、同帖可跨批次，每批领用不超可用张数、只分给允许的帖；按最大流求**总缺口最小**的分配，逐帖返回批次领用明细与缺口、逐批返回领用合计与剩余张数；库存不足时响应仍为 200，`totals.fullyCovered` 为 `false` 并给出逐帖缺口；
  - 批次非数组 / 为空 / 超过 12 个、批号为空或重复、可用张数非正整数、帖号非整数 / 超出范围 / 同批重复等均返回 400 明确错误。

后两个爬移参数任一为 0（或不传）时不做爬移补偿，所有页位 `offsetMm` 为 0，旧调用方无需改动。

响应（节选）：完整拼版清单，与前端导出的 JSON 一致。`creep.sheetCompensationMm` 按每帖张数上限由外向内给出补偿量；**每个帖对象另带 `actualSheetCount`（实际张数）、`actualPageCount`（实际页数）、`blankPages`（本帖空白页数）与按该帖实际层数重算的 `sheetCompensationMm`**；每个页位对象（含空白页）都带 `offsetMm`；启用适配检查时每个页位另带 `fit`，顶层 `fit` 给出整体汇总。

顶层 `balanced` 汇总分帖模式：

- 固定分帖（`balancedSplit` 缺省 / `false`）：`{ "enabled": false }`；
- 均衡分帖：

```json
{
  "enabled": true,
  "maxSheetsPerSignature": 2,
  "totalSheets": 5,
  "fixedSignatureCount": 3,
  "fixedPaddedPages": 24,
  "fixedBlankPages": 7,
  "savedBlankPages": 4,
  "actualSheetCounts": [2, 2, 1]
}
```

顶层 `chapters` 汇总章节优先分帖：未启用时为 `{ "enabled": false }`；启用时包含规范化后的章节起始页 `starts`、章节列表 `list`、拆分总次数 `splitCount`、被拆分章节 `splitChapters` 与各帖实际张数 `actualSheetCounts`（结构见上文「章节优先分帖」一节）。章节模式下每个帖对象另带 `chapters`（本帖覆盖章节），`pageStart` / `pageEnd` 为**真实页范围**（补白页不占页码）。

```json
{
  "input": {
    "totalPages": 8,
    "sheetsPerSignature": 2,
    "balancedSplit": false,
    "binding": "left",
    "flip": "short",
    "paperThickness": 0.1,
    "maxCompensation": 0.15
  },
  "pagesPerSignature": 8,
  "signatureCount": 1,
  "paddedPages": 8,
  "blankPages": 0,
  "balanced": { "enabled": false },
  "creep": {
    "paperThickness": 0.1,
    "maxCompensation": 0.15,
    "enabled": true,
    "sheetCompensationMm": [0, 0.15]
  },
  "signatures": [
    {
      "index": 1,
      "pageStart": 1,
      "pageEnd": 8,
      "actualSheetCount": 2,
      "actualPageCount": 8,
      "blankPages": 0,
      "sheetCompensationMm": [0, 0.15],
      "sheets": [
        {
          "index": 1,
          "front": {
            "left": { "page": 8, "blank": false, "offsetMm": 0 },
            "right": { "page": 1, "blank": false, "offsetMm": 0 }
          },
          "back": {
            "left": { "page": 2, "blank": false, "offsetMm": 0, "backOf": 1 },
            "right": { "page": 7, "blank": false, "offsetMm": 0, "backOf": 8 }
          }
        },
        {
          "index": 2,
          "front": {
            "left": { "page": 6, "blank": false, "offsetMm": 0.15 },
            "right": { "page": 3, "blank": false, "offsetMm": -0.15 }
          }
        }
      ]
    }
  ]
}
```

启用适配检查时，每个页位对象增加 `fit`，例如：

```json
{
  "page": 8,
  "blank": false,
  "offsetMm": 0,
  "fit": {
    "ok": false,
    "rotation": 0,
    "rect": { "x": 0, "y": 0, "width": 220, "height": 310 },
    "trim": { "x": 5, "y": 6.5, "width": 210, "height": 297 },
    "bleedBox": { "x": 2, "y": 3.5, "width": 216, "height": 303 },
    "safeBox": { "x": 10, "y": 11.5, "width": 200, "height": 287 },
    "violations": [
      { "code": "bleed-overflow-left", "message": "左侧出血超出纸张 2mm（出血 5mm，含爬移偏移 0mm）" }
    ]
  }
}
```

顶层 `fit` 汇总：`{ enabled, paperWidth, paperHeight, pageWidth, pageHeight, bleedMm, safetyMm, slotWidth, slotHeight, ok, totalSlots, failCount }`；未启用时仅为 `{ "enabled": false }`。

启用双面生产标记时，每张纸对象增加 `productionMarks`：`front` / `back` 各含 `placed[]`（已落位标记：`id` / `type`（`crop` / `fold` / `register`）/ `label` / `position` / `positionLabel` / `side` / `segments[]`（`{x1,y1,x2,y2}`，纸张坐标系 mm）；背面标记另带 `pairedWith` 与 `transform`）与 `omitted[]`（省略标记：`reasonCode` / `reasonSummary` / 完整 `reason` 与逐候选 `attempts`；背面省略记 `paired-front-omitted`）。顶层 `productionMarks` 汇总尺寸、间隙、正背变换与放置 / 省略计数（结构与示例见上文「双面生产标记」一节）；未启用时仅为 `{ "enabled": false }`，纸张对象不带 `productionMarks` 字段。

启用试印核验时，顶层增加 `verification`：

- `observations`：规范化后的观察（含 1 起始序号 `index`）；
- `candidates`：四种「装订 × 翻转」候选，按「错误观察数 → 错误字段数 → 当前设置优先 → 固定组合顺序」排序，各含 `rank` / `isCurrent` / `tied` / `zeroDiff` / `wrongObservations` / `wrongFields` 与逐条比对 `details`（每条含 `observed` / `expected` / `pageMatch` / `orientationMatch`（`null` = 空白跳过）/ `wrongFields` / `match`）；
- `conclusion`：`status` 为 `verified`（唯一零差异，附 `combination` 与 `matchesCurrent`）/ `undetermined`（并列最优，附 `tied` 并列组合）/ `failed`（附最接近的 `best`），以及可读结论 `message`；
- `nextSuggestion`：**仅 `undetermined` 时计算**的下一处观察建议——`null` 表示无建议（所有未观察页位在并列组合下预期完全一致）；否则为 `{ signature, sheet, side, position, candidates, outcomeGroups, groupCount, worstRemainingCandidates }`（定位 + 各并列候选预期值 + 结果分组，详见上文「下一处观察建议」）；`verified` / `failed` 时恒为 `null`。

未启用核验时 `verification` 仅为 `{ "enabled": false }`。

启用印刷备料时，顶层增加 `materialPrep`（结构与示例见上文「印刷备料」一节）：逐帖 `signatures[]` 给出 `signature` / `actualSheetCount` / `copies` / `netSheets`（净用纸）/ `makereadySheets`（开机损耗）/ `processWaste`（过程损耗，含逐帖取整余量）/ `totalWaste`（损耗合计）/ `requiredSheets`（需领纸）；`totals` 给出逐帖汇总后的净用纸 / 各类损耗 / 需领纸合计，以及整包采购 `purchasePacks`（采购包数）/ `sheetsPerPack` / `purchaseSheets`（采购张数）/ `packRemainder`（包余）。未启用时响应中不含 `materialPrep` 字段。

启用采购报价组合时，顶层增加 `purchaseQuotes`（结构与示例见上文「采购报价组合」一节）：`demandSheets` / `demandSource`（`manual` 手工 / `materialPrep` 接入备料整包采购张数）/ 回显的 `quotes[]`；可行时 `feasible: true`，逐报价 `rows[]` 给出 `packs`（采购包数）/ `sheets`（采购张数）/ `amountCents`（金额，分）/ `remainingPacks` / `remainingSheets`（可购余量），`totals` 给出 `totalPacks` / `totalSheets` / `overPurchaseSheets`（超购张数）/ `totalCostCents`（总价，分）/ `supplierCount` / `suppliers`；无可行组合时 `feasible: false`，给出 `gapSheets`（缺口张数）/ `reason` / `maxPurchasableSheets`，`rows[]` 按各报价上限给出尽最大可购量（余量为 0）。未启用时响应中不含 `purchaseQuotes` 字段。

启用双版本共版印刷时，顶层增加 `dualVersion`（结构与示例见上文「双版本共版印刷」一节）：回显 `copiesA` / `copiesB` 与去重升序后的 `changedPages`；`rows[]` 逐面给出 `signature` / `sheet` / `side` / `leftPage` / `rightPage`（空白页位为 `null`）/ `changedPages`（本面含有的改动页）/ `shared`（是否共版）/ `plates[]`（共版为 1 块 `shared` 印版、印次 = A + B；拆版为 `A`、`B` 两块印版、各按自身份数印刷）；`totals` 汇总 `sideCount`（面数）/ `sharedSideCount` / `splitSideCount` / `sharedPlateCount` / `splitPlateCount` / `plateCount`（印版总数）/ `savedPlateCount`（较全部拆版节省的印版数）/ `impressions`（总印次）。未启用时响应中不含 `dualVersion` 字段。

参数非法时返回 `400` 与错误信息（含纸张厚度 / 最大补偿量为负，尺寸参数为负、非数字或只提供部分尺寸，`balancedSplit` / `chapterSplit` 非布尔值，两种分帖模式同时启用，章节起始页非数组 / 为空 / 非整数 / 重复 / 未递增 / 越界，观察记录非数组 / 超过 12 条 / 索引越界 / 重复观察 / 字段非法，`productionMarks` 非布尔值、未启用适配检查就开启生产标记、`markSizeMm` 非正数或超过 100mm，备料参数 `materialPrep` 非对象、成品份数 / 每包张数非正整数、开机损耗为负、过程损耗率不在 [0, 1)，采购报价 `purchaseQuotes` 非对象、未启用备料又未给需求张数、报价非数组 / 为空 / 超过 8 条、供应商为空或重复、每包张数非正整数、每包价格（分）为负或非整数、包数边界非法（< 0 / < 1 / 最多少于最少），双版本共版 `dualVersion` 非对象、A / B 版份数非正整数、改动页码缺失 / 为空 / 非整数 / 越界（1 ~ totalPages）/ 区间起点大于终点 / 条目无法解析，以及库存批次领纸 `stockBatches` 非对象、未启用备料就启用本模块、批次非数组 / 为空 / 超过 12 个、批号为空或重复、可用张数非正整数、允许帖号非整数 / 超出帖数范围 / 同批重复等情况）。另提供 `GET /api/health` 健康检查。

调用示例（生成带双面生产标记的拼版清单，460×330 纸张放 210×297 成品页，短边翻转）：

```bash
curl -s -X POST http://localhost:8080/api/impose \
  -H 'Content-Type: application/json' \
  -d '{
    "totalPages": 8,
    "sheetsPerSignature": 2,
    "binding": "left",
    "flip": "short",
    "paperWidth": 460,
    "paperHeight": 330,
    "pageWidth": 210,
    "pageHeight": 297,
    "bleedMm": 3,
    "safetyMm": 5,
    "productionMarks": true,
    "markSizeMm": 5
  }' | jq '.productionMarks | { enabled, markSizeMm, placedCount, omittedCount }'
# => { "enabled": true, "markSizeMm": 5, "placedCount": 48, "omittedCount": 0 }
```

调用示例（启用印刷备料：16 页、2 帖各 2 张、1000 份、每帖开机损耗 10 张、过程损耗率 3%、每包 500 张）：

```bash
curl -s -X POST http://localhost:8080/api/impose \
  -H 'Content-Type: application/json' \
  -d '{
    "totalPages": 16,
    "sheetsPerSignature": 2,
    "binding": "left",
    "flip": "short",
    "materialPrep": { "copies": 1000, "makereadySheets": 10, "processWasteRate": 0.03, "sheetsPerPack": 500 }
  }' | jq '.materialPrep.totals'
# => { "signatureCount": 2, "netSheets": 4000, "makereadySheets": 20, "processWaste": 126,
#      "totalWaste": 146, "requiredSheets": 4146, "purchasePacks": 9,
#      "sheetsPerPack": 500, "purchaseSheets": 4500, "packRemainder": 354 }
```

调用示例（在同一请求中启用采购报价组合，需求张数缺省自动接入备料整包采购张数 4500）：

```bash
curl -s -X POST http://localhost:8080/api/impose \
  -H 'Content-Type: application/json' \
  -d '{
    "totalPages": 16,
    "sheetsPerSignature": 2,
    "binding": "left",
    "flip": "short",
    "materialPrep": { "copies": 1000, "makereadySheets": 10, "processWasteRate": 0.03, "sheetsPerPack": 500 },
    "purchaseQuotes": {
      "quotes": [
        { "supplier": "华泰纸行", "sheetsPerPack": 500, "pricePerPackCents": 9800, "minPacks": 0, "maxPacks": 20 },
        { "supplier": "恒丰纸业", "sheetsPerPack": 500, "pricePerPackCents": 9500, "minPacks": 0, "maxPacks": 20 }
      ]
    }
  }' | jq '.purchaseQuotes | { feasible, demandSource, totals, rows: [.rows[] | { supplier, packs, amountCents }] }'
# => { "feasible": true, "demandSource": "materialPrep",
#      "totals": { "totalPacks": 9, "totalSheets": 4500, "overPurchaseSheets": 0,
#                  "totalCostCents": 85500, "supplierCount": 1, "suppliers": ["恒丰纸业"] },
#      "rows": [ { "supplier": "华泰纸行", "packs": 0, "amountCents": 0 },
#                { "supplier": "恒丰纸业", "packs": 9, "amountCents": 85500 } ] }
```

调用示例（启用双版本共版：16 页、2 帖各 2 张，A 版 1000 份、B 版 500 份，B 版改动页 3、5–8）：

```bash
curl -s -X POST http://localhost:8080/api/impose \
  -H 'Content-Type: application/json' \
  -d '{
    "totalPages": 16,
    "sheetsPerSignature": 2,
    "binding": "left",
    "flip": "short",
    "dualVersion": { "copiesA": 1000, "copiesB": 500, "changedPages": "3, 5-8" }
  }' | jq '.dualVersion | { changedPages, totals }'
# => { "changedPages": [3, 5, 6, 7, 8],
#      "totals": { "sideCount": 8, "sharedSideCount": 4, "splitSideCount": 4,
#                  "sharedPlateCount": 4, "splitPlateCount": 8, "plateCount": 12,
#                  "savedPlateCount": 4, "impressions": 12000 } }
```

调用示例（启用库存批次领纸：8 页、每帖 1 张共 2 帖，份数 10、无损耗 -> 每帖需领纸 10 张；通用批 10 张 + 仅供第 1 帖的批 10 张，两帖均无缺口）：

```bash
curl -s -X POST http://localhost:8080/api/impose \
  -H 'Content-Type: application/json' \
  -d '{
    "totalPages": 8,
    "sheetsPerSignature": 1,
    "binding": "left",
    "flip": "short",
    "materialPrep": { "copies": 10, "makereadySheets": 0, "processWasteRate": 0, "sheetsPerPack": 100 },
    "stockBatches": {
      "batches": [
        { "lot": "ALL", "availableSheets": 10 },
        { "lot": "S1", "availableSheets": 10, "allowedSignatures": [1] }
      ]
    }
  }' | jq '.stockBatches | { signatures: [.signatures[] | { signature, drawnSheets, gapSheets }], batches: [.batches[] | { lot, drawnSheets, remainingSheets }], totals }'
# => { "signatures": [ { "signature": 1, "drawnSheets": 10, "gapSheets": 0 },
#                      { "signature": 2, "drawnSheets": 10, "gapSheets": 0 } ],
#      "batches": [ { "lot": "ALL", "drawnSheets": 10, "remainingSheets": 0 },
#                   { "lot": "S1", "drawnSheets": 10, "remainingSheets": 0 } ],
#      "totals": { "signatureCount": 2, "batchCount": 2, "requiredSheets": 20,
#                  "availableSheets": 20, "drawnSheets": 20, "remainingSheets": 0,
#                  "gapSheets": 0, "fullyCovered": true } }
```

## 目录结构

```
├── server.js            # Express 服务：静态页面 + /api/impose
├── src/imposition.js      # 拼版计算核心（固定 / 均衡 / 章节优先分帖、正反面页位、翻转坐标变换、爬移补偿 offsetMm）
├── src/fitCheck.js        # 纸张规格与出血 / 安全区适配检查（可用矩形、trim/bleed/safe、超限原因）
├── src/productionMarks.js # 双面生产标记（裁切线 / 折线标 / 套准十字候选落位、正背坐标变换、省略原因）
├── src/verification.js    # 试印核验（观察校验、四种装订×翻转重算比对、候选排序与结论）
├── src/materialPrep.js    # 印刷备料（逐帖净用纸 / 开机损耗 / 过程损耗 / 需领纸 ceil、整包采购汇总）
├── src/purchaseQuote.js   # 采购报价组合（分整数计价、边界约束、四级排序唯一方案、缺口、有界 DP 求解）
├── src/dualVersion.js     # 双版本共版印刷（改动页码解析校验、逐张逐面印版归属判定、印版 / 印次汇总）
├── src/stockBatches.js    # 库存批次领纸（批次录入校验、最大流求总缺口最小分配、逐帖缺口与逐批剩余）
├── public/                # 前端（原生 Canvas 逐张绘制、原始/补偿页位叠加、适配标记、生产标记、试印核验面板、印刷备料面板、采购报价组合面板、双版本共版面板、库存批次领纸面板、JSON 导出）
│   ├── index.html
│   ├── app.js
│   └── style.css
├── test/imposition.test.js
├── test/fitCheck.test.js
├── test/productionMarks.test.js
├── test/chapterSplit.test.js
├── test/verification.test.js
├── test/materialPrep.test.js
├── test/purchaseQuote.test.js
├── test/dualVersion.test.js
├── test/stockBatches.test.js
├── test/api.test.js
├── Dockerfile
└── docker-compose.yml
```
