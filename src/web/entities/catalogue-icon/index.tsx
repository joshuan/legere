'use client';

import {
  ApartmentOutlined,
  BankOutlined,
  HomeOutlined,
  CarOutlined,
  ShopOutlined,
  MedicineBoxOutlined,
  ReadOutlined,
  RocketOutlined,
  FileTextOutlined,
  ToolOutlined,
  GlobalOutlined,
  FolderOutlined,
  HeartOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useState } from 'react';
import {
  catalogueIconResponseSchema,
  type CatalogueIcon,
  type CatalogueIconTarget,
  type CatalogueSymbol,
} from '../../../shared/contracts/catalogue-icons';
import { apiClient, uploadFile } from '../../shared/api';

const symbols = {
  building: ApartmentOutlined,
  bank: BankOutlined,
  home: HomeOutlined,
  car: CarOutlined,
  shop: ShopOutlined,
  health: MedicineBoxOutlined,
  education: ReadOutlined,
  travel: RocketOutlined,
  document: FileTextOutlined,
  tool: ToolOutlined,
  globe: GlobalOutlined,
  folder: FolderOutlined,
  heart: HeartOutlined,
  person: UserOutlined,
};

export function CatalogueSymbolIcon({ symbol }: { symbol: CatalogueSymbol }) {
  const Icon = symbols[symbol];
  return <Icon aria-hidden />;
}

export function CatalogueIconView({
  icon,
  target,
  id,
}: {
  icon: CatalogueIcon | null;
  target: CatalogueIconTarget;
  id: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (icon?.type === 'image' && failed !== icon.revision) {
    return (
      // Private images redirect to signed object-storage URLs; shared image optimization is unsuitable.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className="legere-catalogue-logo"
        src={`/api/catalogue-icons/${target}/${id}/image?v=${icon.revision}`}
        alt=""
        loading="lazy"
        onError={() => setFailed(icon.revision)}
      />
    );
  }
  return <CatalogueSymbolIcon symbol={icon?.type === 'symbol' ? icon.symbol : 'folder'} />;
}

export const catalogueIconApi = {
  symbol: (target: CatalogueIconTarget, id: string, symbol: CatalogueSymbol | null) =>
    apiClient.patch(`/api/admin/catalogue-icons/${target}/${id}`, {
      schema: catalogueIconResponseSchema,
      body: { symbol },
    }),
  upload: (target: CatalogueIconTarget, id: string, file: File) =>
    uploadFile(`/api/admin/catalogue-icons/${target}/${id}/image`, file, {
      schema: catalogueIconResponseSchema,
    }),
};
