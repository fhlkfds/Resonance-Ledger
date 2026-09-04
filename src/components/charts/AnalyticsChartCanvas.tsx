'use client';

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, HeatmapChart, LineChart, PieChart } from 'echarts/charts';
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  HeatmapChart,
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

export type ChartKind = 'line' | 'column' | 'bar' | 'donut' | 'heatmap';

export type ChartSeries = {
  name: string;
  values: number[];
};

export type AnalyticsChartProps = {
  kind: ChartKind;
  categories: string[];
  series: ChartSeries[];
  /** Sentence describing the chart for assistive technology. */
  description: string;
  /** Renders durations as hours rather than raw milliseconds on the axis. */
  asDuration?: boolean;
  height?: number;
};

const ACCENT = '#d6ff69';
const PALETTE = [
  '#d6ff69',
  '#7cc4ff',
  '#ff9ecb',
  '#ffc46b',
  '#9d8bff',
  '#5fe3c0',
  '#ff8a7a',
  '#b8c4d0',
];

const AXIS_LABEL = { color: '#9da7b3' };
const SPLIT_LINE = { lineStyle: { color: '#ffffff12' } };

function hoursFormatter(value: number): string {
  const hours = value / 3_600_000;
  return hours >= 1
    ? `${Math.round(hours)}h`
    : `${Math.round(value / 60_000)}m`;
}

export default function AnalyticsChartCanvas({
  kind,
  categories,
  series,
  description,
  asDuration = false,
  height = 288,
}: AnalyticsChartProps) {
  const target = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!target.current) return;
    const chart = echarts.init(target.current, undefined, {
      renderer: 'canvas',
    });

    const valueAxis = {
      type: 'value' as const,
      minInterval: asDuration ? undefined : 1,
      axisLabel: {
        ...AXIS_LABEL,
        ...(asDuration ? { formatter: hoursFormatter } : {}),
      },
      splitLine: SPLIT_LINE,
    };
    const categoryAxis = {
      type: 'category' as const,
      data: categories,
      axisLabel: AXIS_LABEL,
    };

    const common = {
      aria: {
        enabled: true,
        decal: { show: true },
        description,
      },
      backgroundColor: 'transparent',
      textStyle: { color: '#f0f4f8' },
      color: PALETTE,
      tooltip:
        kind === 'heatmap'
          ? {
              trigger: 'item' as const,
              formatter: ({ value }: { value: number[] }) => {
                const [hour = 0, weekday = 0, metric = 0] = value;
                const formatted = asDuration
                  ? hoursFormatter(metric)
                  : metric.toLocaleString();
                return `${series[weekday]?.name ?? ''} ${categories[hour] ?? ''}: ${formatted}`;
              },
            }
          : {
              trigger: kind === 'donut' ? ('item' as const) : ('axis' as const),
            },
      legend:
        series.length > 1
          ? { textStyle: { color: '#9da7b3' }, top: 0 }
          : { show: false },
    };

    if (kind === 'heatmap') {
      const values = series.flatMap((entry, weekday) =>
        entry.values.map((value, hour) => [hour, weekday, value]),
      );
      chart.setOption({
        ...common,
        grid: { left: 12, right: 16, top: 16, bottom: 56, containLabel: true },
        xAxis: categoryAxis,
        yAxis: {
          type: 'category',
          data: series.map((entry) => entry.name),
          axisLabel: AXIS_LABEL,
        },
        visualMap: {
          min: 0,
          max: Math.max(1, ...values.map((entry) => entry[2]!)),
          calculable: true,
          orient: 'horizontal',
          left: 'center',
          bottom: 0,
          textStyle: AXIS_LABEL,
          inRange: { color: ['#17201f', ACCENT] },
        },
        series: [{ type: 'heatmap', data: values }],
      });
    } else if (kind === 'donut') {
      chart.setOption({
        ...common,
        series: [
          {
            type: 'pie',
            radius: ['45%', '72%'],
            itemStyle: { borderColor: '#0d1117', borderWidth: 2 },
            label: { color: '#9da7b3' },
            data: categories.map((name, index) => ({
              name,
              value: series[0]?.values[index] ?? 0,
            })),
          },
        ],
      });
    } else if (kind === 'bar') {
      // Horizontal ranking bars read top-down, so the category axis is inverted.
      chart.setOption({
        ...common,
        grid: {
          left: 8,
          right: 24,
          top: series.length > 1 ? 32 : 12,
          bottom: 32,
          containLabel: true,
        },
        xAxis: valueAxis,
        yAxis: { ...categoryAxis, inverse: true },
        series: series.map((entry) => ({
          type: 'bar',
          name: entry.name,
          data: entry.values,
          itemStyle: { color: ACCENT, borderRadius: [0, 4, 4, 0] },
        })),
      });
    } else {
      chart.setOption({
        ...common,
        grid: {
          left: 12,
          right: 16,
          top: series.length > 1 ? 32 : 24,
          bottom: 24,
          containLabel: true,
        },
        xAxis: categoryAxis,
        yAxis: valueAxis,
        series: series.map((entry, index) => ({
          type: kind === 'column' ? 'bar' : 'line',
          name: entry.name,
          data: entry.values,
          smooth: kind === 'line',
          showSymbol: kind === 'line' && categories.length < 40,
          ...(kind === 'column'
            ? {
                itemStyle: {
                  color: PALETTE[index % PALETTE.length],
                  borderRadius: [4, 4, 0, 0],
                },
              }
            : {
                lineStyle: { color: PALETTE[index % PALETTE.length] },
                ...(series.length === 1
                  ? { areaStyle: { color: '#d6ff6920' } }
                  : {}),
              }),
        })),
      });
    }

    const resize = new ResizeObserver(() => chart.resize());
    resize.observe(target.current);
    return () => {
      resize.disconnect();
      chart.dispose();
    };
  }, [asDuration, categories, description, kind, series]);

  return (
    <div
      ref={target}
      style={{ height }}
      className="w-full"
      role="img"
      aria-label={description}
    />
  );
}
