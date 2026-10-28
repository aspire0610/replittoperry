import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketRouter from "./market";
import accountRouter from "./account";
import lineClosingSummaryRouter from "./line-closing-summary";
import linePremarketSummaryRouter from "./line-premarket-summary";
import lineQuantSignalsRouter from "./line-quant-signals";

const router: IRouter = Router();

router.use(healthRouter);
router.use(marketRouter);
router.use(lineClosingSummaryRouter);
router.use(linePremarketSummaryRouter);
router.use(lineQuantSignalsRouter);
router.use(accountRouter);

export default router;
