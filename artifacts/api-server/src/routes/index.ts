import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketRouter from "./market";
import accountRouter from "./account";
import lineClosingSummaryRouter from "./line-closing-summary";
import linePremarketSummaryRouter from "./line-premarket-summary";

const router: IRouter = Router();

router.use(healthRouter);
router.use(marketRouter);
router.use(lineClosingSummaryRouter);
router.use(linePremarketSummaryRouter);
router.use(accountRouter);

export default router;
