'use client';

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  AriaComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  AriaComponent,
  CanvasRenderer,
]);

export type TrendPoint = {
  bucket: string;
  plays: number;
  estimatedDurationMs: number;
};

export default function EChartCanvas({
  points,
  metric,
}: {
  points: TrendPoint[];
  metric: 'plays' | 'estimatedDurationMs';
}) {
  const target = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!target.current) return;
    const chart = echarts.init(target.current, undefined, {
      renderer: 'canvas',
    });
    chart.setOption({
      aria: {
        enabled: true,
        decal: { show: true },
        description: `Listening trend showing ${metric === 'plays' ? 'plays' : 'estimated listening time'}.`,
      },
      backgroundColor: 'transparent',
      textStyle: { color: '#f0f4f8' },
      grid: { left: 48, right: 16, top: 24, bottom: 48 },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: points.map(({ bucket }) => bucket),
        axisLabel: { color: '#9da7b3' },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: { color: '#9da7b3' },
        splitLine: { lineStyle: { color: '#ffffff12' } },
      },
      series: [
        {
          type: 'line',
          smooth: true,
          showSymbol: points.length < 40,
          areaStyle: { color: '#d6ff6920' },
          lineStyle: { color: '#d6ff69' },
          data: points.map((point) => point[metric]),
        },
      ],
    });
    const resize = new ResizeObserver(() => chart.resize());
    resize.observe(target.current);
    return () => {
      resize.disconnect();
      chart.dispose();
    };
  }, [metric, points]);
  return (
    <div
      ref={target}
      className="h-72 w-full"
      role="img"
      aria-label="Listening trend chart"
    />
  );
}
