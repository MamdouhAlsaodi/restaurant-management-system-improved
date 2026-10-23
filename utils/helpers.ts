
import { Discount, MenuItem, Order, Settings, SalesAnalytics } from '../types';

export const formatDate = (d: Date | string): string => {
  const date = d instanceof Date ? d : new Date(d);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
};

export const getItemPrice = (item: MenuItem, discounts: Discount[]): number => {
  const now = new Date();
  const activeDiscount = discounts.find(d => {
    if (!d.active || d.itemId !== item.id) return false;
    const start = new Date(d.startDate);
    const end = new Date(d.endDate);
    end.setHours(23, 59, 59, 999);
    return now >= start && now <= end;
  });

  return activeDiscount ? activeDiscount.discountPrice : item.price;
};

export const calculateOrderTotal = (items: {price: number, quantity: number}[]) => {
  return items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
};

export const SPECIAL_MENU_CATEGORY = 'قائمة خاصة (Limited)';

export const CATEGORIES = [
  'بلا تصنيف',
  'Mix Arbe',
  'Salda',
  'Fata',
  'Pasta Arbe',
  'Berite',
  'Berite Extra',
  'Shawarma',
  'Kibelobania',
  'Kibe',
  'Kibe Cru',
  'Esfihas',
  'Esfihas Fsado',
  'Kafta',
  'Yabrak',
  'Falafel',
  'Bebidas',
  'Sobremesas',
  'Cola'
];

export const getSalesAnalytics = (
  orders: Order[],
  settings: Settings,
  targetDate: string
): SalesAnalytics => {
  const dateOrders = orders.filter(o => o.dateOnly === targetDate && o.status !== 'cancelled');
  const totalSales = dateOrders.reduce((s, o) => s + o.total, 0);

  const paymentBreakdown: Record<string, number> = { cash: 0, pix: 0, ifood_card: 0, cartao: 0 };
  dateOrders.forEach(o => {
    if (Object.prototype.hasOwnProperty.call(paymentBreakdown, o.paymentMethod)) {
      paymentBreakdown[o.paymentMethod] += o.total;
    } else {
        // Handle unexpected payment methods
        paymentBreakdown[o.paymentMethod] = (paymentBreakdown[o.paymentMethod] || 0) + o.total;
    }
  });

  const itemsSold: Record<string, { quantity: number; total: number }> = {};
  dateOrders.forEach(o => {
    o.items.forEach(i => {
      if (itemsSold[i.name]) {
        itemsSold[i.name].quantity += i.quantity;
        itemsSold[i.name].total += i.price * i.quantity;
      } else {
        itemsSold[i.name] = { quantity: i.quantity, total: i.price * i.quantity };
      }
    });
  });

  const deliveryCount = dateOrders.filter(o => o.needsDelivery).length;
  const deliveryCost = settings.dailyMotorcycleCost + (deliveryCount * settings.perDeliveryCost);

  const sourceBreakdown: Record<string, number> = {};
  dateOrders.forEach(o => {
    sourceBreakdown[o.orderSource] = (sourceBreakdown[o.orderSource] || 0) + 1;
  });

  const typeBreakdown: Record<string, number> = {};
  dateOrders.forEach(o => {
    typeBreakdown[o.orderType] = (typeBreakdown[o.orderType] || 0) + 1;
  });

  const cancelledCount = orders.filter(o => o.dateOnly === targetDate && o.status === 'cancelled').length;

  return {
    date: targetDate,
    totalSales,
    paymentBreakdown,
    itemsSold,
    deliveryCount,
    deliveryCost,
    netProfit: totalSales - deliveryCost,
    ordersCount: dateOrders.length,
    sourceBreakdown,
    typeBreakdown,
    cancelledCount
  };
};
