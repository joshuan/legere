'use client';

import { Table, type TableProps } from 'antd';

export function ResponsiveTable<Row extends object>({ scroll, ...props }: TableProps<Row>) {
  return <Table<Row> {...props} scroll={{ x: 'max-content', ...scroll }} />;
}
