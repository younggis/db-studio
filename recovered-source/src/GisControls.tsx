import { Checkbox, Progress } from "antd";
import type { ComponentProps } from "react";

export function GisCheckbox(props: ComponentProps<typeof Checkbox>) {
  return <Checkbox {...props} />;
}

export function GisProgress(props: ComponentProps<typeof Progress>) {
  return <Progress {...props} />;
}