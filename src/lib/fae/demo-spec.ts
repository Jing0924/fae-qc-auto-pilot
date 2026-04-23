import type { ColumnThresholds } from "@/lib/fae/csv-spec-thresholds";

/** 與 `public/samples/demo-product-spec-zh.md` 中表格一致，供門檻掃與表單預填。 */
export const DEMO_DEFAULT_THRESHOLDS: ColumnThresholds = {
  temp_c: { min: -40, max: 85 },
  vcore_mv: { min: 1000, max: 1200 },
};

export const DEFAULT_THRESHOLDS_JSON = JSON.stringify(
  DEMO_DEFAULT_THRESHOLDS,
  null,
  2,
);

export const DEMO_SPEC_PATH = "public/samples/demo-product-spec-zh.md";
