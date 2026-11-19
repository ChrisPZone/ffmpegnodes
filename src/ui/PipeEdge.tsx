import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";

export interface PipeEdgeData extends Record<string, unknown> {
  media: string;
  domain: "frames" | "packets" | "params";
  label?: string;
  conversion?: string;
  severity?: "error" | "warning";
}

export type PipeEdge = Edge<PipeEdgeData, "pipe">;

export function PipeEdgeView(props: EdgeProps<PipeEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd } = props;
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const media = data?.media ?? "any";
  const domain = data?.domain ?? "frames";
  const text = [data?.label, data?.conversion ? `⚠ ${data.conversion}` : ""].filter(Boolean).join("  ");
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        className={`pipe media-${media} ${domain} ${selected ? "selected" : ""} ${data?.severity ? `sev-${data.severity}` : ""}`}
      />
      {text && (
        <EdgeLabelRenderer>
          <div
            className={`edge-label ${data?.conversion ? "conversion" : ""}`}
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
          >
            {text}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = { pipe: PipeEdgeView };
