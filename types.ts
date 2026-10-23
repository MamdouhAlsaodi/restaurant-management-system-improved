
export type Language = 'ar' | 'en' | 'pt';

export interface MenuItem {
  id: number;
  name: string;
  price: number;
  image: string;
  category: string;
  description?: string;
  order?: number;
  isFavorite?: boolean;
}

export interface OrderItem extends MenuItem {
  quantity: number;
}

export interface Order {
  id: number;
  items: OrderItem[];
  total: number;
  paymentMethod: string;
  orderSource: string;
  orderType: string;
  needsDelivery: boolean;
  notes: string;
  date: string;
  dateOnly: string;
  status: 'completed' | 'cancelled';
}

export interface Discount {
  id: number;
  itemId: number;
  discountPrice: number;
  startDate: string;
  endDate: string;
  active: boolean;
}

export interface Settings {
  dailyMotorcycleCost: number;
  perDeliveryCost: number;
  showLimitedMenu?: boolean;
  language?: Language;
}

export interface DailySalesRecord {
  date: string;
  totalSales: number;
  ordersCount: number;
  deliveryCount: number;
  deliveryCost: number;
  netProfit: number;
  paymentBreakdown: Record<string, number>;
  sourceBreakdown: Record<string, number>;
  typeBreakdown: Record<string, number>;
  itemsSold: Record<string, { quantity: number; total: number }>;
  cancelledCount: number;
  savedAt?: string;
  orders?: Order[];
}

export interface SalesAnalytics extends DailySalesRecord {}