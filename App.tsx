
import React, { useState, useEffect } from 'react';
import { MenuItem, Order, Settings, Discount, DailySalesRecord, OrderItem, Language } from './types';
import { CATEGORIES, formatDate, getItemPrice, SPECIAL_MENU_CATEGORY } from './utils/helpers';
import { apiFetch } from './utils/qr/api';
import {
  ServerOrder,
  canAddItems,
  canApprove,
  canCheckout,
  combineForReporting,
  isPaid,
  mapServerOrder,
  retryPersistedWrite,
} from './utils/qr/adminOrders';
import { PublishedMenuItem } from './utils/qr/helpers';
import OrderInbox, { InboxTable } from './components/qr/OrderInbox';
import { translations } from './utils/translations';
import MenuView from './components/views/MenuView';
import SalesView from './components/views/SalesView';
import OrdersView from './components/views/OrdersView';
import HistoryView from './components/views/HistoryView';
import AddItemModal from './components/modals/AddItemModal';
import CheckoutModal from './components/modals/CheckoutModal';
import CartModal from './components/modals/CartModal';
import SettingsModal from './components/modals/SettingsModal';
import DiscountsModal from './components/modals/DiscountsModal';
import QRPanel from './components/qr/QRPanel';
import { Settings as SettingsIcon, ShoppingCart } from 'lucide-react';

const App = () => {
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [currentOrder, setCurrentOrder] = useState<OrderItem[]>([]);
  const [completedOrders, setCompletedOrders] = useState<Order[]>([]);
  const [discounts, setDiscounts] = useState<Discount[]>([]);
  const [view, setView] = useState<'menu' | 'sales' | 'orders' | 'history' | 'qr'>('menu');
  const [showAddItem, setShowAddItem] = useState(false);
  const [showCart, setShowCart] = useState(false);
  const [showCheckout, setShowCheckout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showDiscounts, setShowDiscounts] = useState(false);
  const [settings, setSettings] = useState<Settings>({ dailyMotorcycleCost: 30, perDeliveryCost: 10, showLimitedMenu: false, language: 'ar' });
  const [dailySalesRecords, setDailySalesRecords] = useState<Record<string, DailySalesRecord>>({});

  // -- Server multi-order state (SQLite; never written to localStorage) --
  const [serverOrders, setServerOrders] = useState<ServerOrder[]>([]);
  const [serverLoadError, setServerLoadError] = useState('');
  const [serverActionError, setServerActionError] = useState('');
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [busyServerId, setBusyServerId] = useState<string | null>(null);
  const [inboxTables, setInboxTables] = useState<InboxTable[]>([]);
  const [publishedMenu, setPublishedMenu] = useState<PublishedMenuItem[]>([]);
  const [checkoutServerOrder, setCheckoutServerOrder] = useState<ServerOrder | null>(null);

  const language: Language = settings.language || 'ar';
  const t = translations[language];

  // Update Document Direction based on Language
  useEffect(() => {
    const dir = language === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.dir = dir;
    document.documentElement.lang = language;
  }, [language]);

  // Format for state tracking (Sales View)
  const [selectedSalesDate, setSelectedSalesDate] = useState(formatDate(new Date()));

  // -- Persistence --
  useEffect(() => {
    try {
      const menuData = localStorage.getItem('restaurant-menu');
      const ordersData = localStorage.getItem('restaurant-orders');
      const settingsData = localStorage.getItem('restaurant-settings');
      const discountsData = localStorage.getItem('restaurant-discounts');
      const salesData = localStorage.getItem('restaurant-daily-sales');

      if (menuData) setMenuItems(JSON.parse(menuData));
      if (ordersData) setCompletedOrders(JSON.parse(ordersData));
      if (settingsData) setSettings(JSON.parse(settingsData));
      if (discountsData) setDiscounts(JSON.parse(discountsData));
      if (salesData) setDailySalesRecords(JSON.parse(salesData));
    } catch (error) {
      console.error('Error loading data', error);
    }
  }, []);

  // -- Server order queue (authenticated same-origin cookie session) --
  const refreshServerOrders = async () => {
    try {
      const data = await apiFetch<{ orders: any[] }>('/api/admin/orders');
      setServerOrders((data.orders ?? []).map(mapServerOrder));
      setServerLoadError('');
    } catch (err: any) {
      setServerLoadError(err?.message ?? 'تعذر تحميل الطلبات');
    }
  };

  const refreshInboxMeta = async () => {
    try {
      const tablesData = await apiFetch<{ tables: InboxTable[] }>('/api/admin/tables');
      setInboxTables(tablesData.tables ?? []);
    } catch { /* table list is optional for manual creation */ }
    try {
      const menuData = await apiFetch<{ items: PublishedMenuItem[] }>('/api/admin/menu');
      setPublishedMenu(menuData.items ?? []);
    } catch { /* published menu may not exist yet */ }
  };

  useEffect(() => {
    refreshServerOrders();
    refreshInboxMeta();
    const timer = setInterval(refreshServerOrders, 5000);
    return () => clearInterval(timer);
  }, []);

  const selectedServerOrder = serverOrders.find((o) => o.id === selectedServerId) ?? null;

  const mergeServerOrder = (order: ServerOrder) => {
    setServerOrders((prev) => {
      const others = prev.filter((o) => o.id !== order.id);
      return [order, ...others];
    });
  };

  const withServerAction = async (order: ServerOrder | null, fn: () => Promise<void>) => {
    if (busyServerId !== null) return false;
    setBusyServerId(order?.id ?? '__global__');
    setServerActionError('');
    try {
      await fn();
      return true;
    } catch (err: any) {
      setServerActionError(err?.message ?? 'حدث خطأ غير متوقع');
      return false;
    } finally {
      setBusyServerId(null);
    }
  };

  const handleServerDecision = (order: ServerOrder, action: 'accept' | 'reject') =>
    withServerAction(order, async () => {
      if (!canApprove(order)) {
        setServerActionError('لا يمكن مراجعة طلب تمت معالجته مسبقاً');
        return;
      }
      const data = await apiFetch<{ order: any }>(`/api/admin/orders/${order.id}/${action}`, { method: 'POST' });
      mergeServerOrder(mapServerOrder(data.order));
    });

  const handleCreateManualOrder = (guestName: string, tableId: number | null) =>
    withServerAction(selectedServerOrder, async () => {
      // Stable requestId across retries: an ambiguous failure replays the same
      // request and the server answers 200 replay instead of duplicating.
      const data = await retryPersistedWrite(`create:${JSON.stringify([guestName, tableId])}`, async (requestId) => {
        const reply = await apiFetch<{ order: any }>('/api/admin/orders', {
          method: 'POST',
          body: { requestId, guestName, tableId: tableId ?? undefined },
        });
        if (!reply?.order?.id) throw new Error('رد غير مكتمل من الخادم؛ أعد المحاولة');
        return reply;
      });
      mergeServerOrder(mapServerOrder(data.order));
      setSelectedServerId(data.order.id);
    });

  const handleAddServerItems = (orderId: string, publishedItemId: string, quantity: number) => {
    const order = serverOrders.find((o) => o.id === orderId);
    if (!order || !canAddItems(order)) {
      setServerActionError('يمكن إضافة الأصناف إلى الطلبات المقبولة غير المدفوعة فقط');
      return false;
    }
    return withServerAction(order, async () => {
      const data = await retryPersistedWrite(`add:${JSON.stringify([orderId, publishedItemId, quantity])}`, async (requestId) => {
        const reply = await apiFetch<{ order: any }>(`/api/admin/orders/${orderId}/items`, {
          method: 'POST',
          body: { requestId, items: [{ id: publishedItemId, quantity }] },
        });
        if (!reply?.order?.id) throw new Error('رد غير مكتمل من الخادم؛ أعد المحاولة');
        return reply;
      });
      mergeServerOrder(mapServerOrder(data.order));
    });
  };

  const handleCheckoutServerOrder = async (order: ServerOrder, paymentMethod: string) => {
    if (busyServerId !== null) throw new Error('هناك عملية أخرى قيد التنفيذ');
    if (!canCheckout(order)) {
      setCheckoutServerOrder(null);
      throw new Error('لا يمكن تحصيل طلب غير مقبول أو مدفوع مسبقاً');
    }
    setBusyServerId(order.id);
    setServerActionError('');
    try {
      const data = await apiFetch<{ order: any }>(`/api/admin/orders/${order.id}/checkout`, {
        method: 'POST',
        body: { paymentMethod },
      });
      mergeServerOrder(mapServerOrder(data.order));
      setCheckoutServerOrder(null);
    } catch (err: any) {
      setServerActionError(err?.message ?? 'تعذر تحصيل الطلب');
      throw err;
    } finally {
      setBusyServerId(null);
    }
  };

  const saveData = (key: string, data: any) => {
    localStorage.setItem(key, JSON.stringify(data));
  };

  const handleUpdateMenuItems = (items: MenuItem[]) => {
    setMenuItems(items);
    saveData('restaurant-menu', items);
  };

  const handleUpdateOrders = (orders: Order[]) => {
    setCompletedOrders(orders);
    saveData('restaurant-orders', orders);
  };

  const handleUpdateSettings = (newSettings: Settings) => {
    // If Special Menu was active and is now being turned off, delete all items in that category
    if (settings.showLimitedMenu && !newSettings.showLimitedMenu) {
        const cleanedMenuItems = menuItems.filter(item => item.category !== SPECIAL_MENU_CATEGORY);
        setMenuItems(cleanedMenuItems);
        saveData('restaurant-menu', cleanedMenuItems);
    }

    setSettings(newSettings);
    saveData('restaurant-settings', newSettings);
    setShowSettings(false);
  };

  const handleUpdateDiscounts = (newDiscounts: Discount[]) => {
    setDiscounts(newDiscounts);
    saveData('restaurant-discounts', newDiscounts);
  };

  // -- Actions --

  const handleAddItem = (item: Omit<MenuItem, 'id'>) => {
    const newItem: MenuItem = { ...item, id: Date.now() };
    handleUpdateMenuItems([...menuItems, newItem]);
  };

  const handleUpdateOrder = (item: MenuItem, qty: number, mode: 'delta' | 'set' = 'delta') => {
    const existing = currentOrder.find(o => o.id === item.id);
    if (existing) {
      const newQty = mode === 'delta' ? existing.quantity + qty : qty;
      if (newQty <= 0) {
        setCurrentOrder(currentOrder.filter(o => o.id !== item.id));
      } else {
        setCurrentOrder(currentOrder.map(o => o.id === item.id ? { ...o, quantity: newQty } : o));
      }
    } else if (qty > 0) {
      setCurrentOrder([...currentOrder, { ...item, quantity: qty }]);
    }
  };

  const handleRemoveFromCart = (id: number) => {
    setCurrentOrder(currentOrder.filter(o => o.id !== id));
  };

  const handleCheckout = (paymentMethod: string, orderSource: string, orderType: string, notes: string, needsDelivery: boolean) => {
    const orderTotal = currentOrder.reduce((sum, item) => {
      // Recalculate price just in case
      const originalItem = menuItems.find(m => m.id === item.id);
      const price = originalItem ? getItemPrice(originalItem, discounts) : item.price;
      return sum + (price * item.quantity);
    }, 0);

    const newOrder: Order = {
      id: Date.now(),
      items: currentOrder,
      total: orderTotal + (needsDelivery ? 10 : 0), // Adding simple delivery fee logic from original code assumption
      paymentMethod,
      orderSource,
      orderType,
      needsDelivery,
      notes,
      date: new Date().toLocaleString(language === 'ar' ? 'ar-SA' : 'en-US'),
      dateOnly: formatDate(new Date()),
      status: 'completed'
    };

    const updatedOrders = [newOrder, ...completedOrders];
    handleUpdateOrders(updatedOrders);
    setCurrentOrder([]);
    setShowCheckout(false);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.menuItems) handleUpdateMenuItems(data.menuItems);
      if (data.completedOrders) handleUpdateOrders(data.completedOrders);
      if (data.settings) handleUpdateSettings(data.settings);
      if (data.discounts) handleUpdateDiscounts(data.discounts);
      if (data.dailySalesRecords) {
          setDailySalesRecords(data.dailySalesRecords);
          saveData('restaurant-daily-sales', data.dailySalesRecords);
      }
      alert('✅ ' + (language === 'ar' ? 'تم استيراد البيانات بنجاح' : 'Data imported successfully'));
    } catch (err) {
      alert('❌ ' + (language === 'ar' ? 'خطأ في الملف' : 'File error'));
    }
  };

  const handleExport = () => {
    const data = {
      menuItems,
      completedOrders,
      settings,
      discounts,
      dailySalesRecords,
      version: '1.2'
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backup-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const totalItemsInCart = currentOrder.reduce((acc, item) => acc + item.quantity, 0);

  // Reporting = legacy local sales + read-only server PAID orders, deduped.
  // Pending/accepted/rejected server orders are never sales. Server paid
  // orders are never written back into restaurant-orders localStorage.
  const unifiedReportingOrders = React.useMemo(
    () => combineForReporting(completedOrders, serverOrders),
    [completedOrders, serverOrders],
  );
  const paidServerCount = serverOrders.filter(isPaid).length;

  const inboxProps = {
    orders: serverOrders,
    tables: inboxTables,
    publishedMenu,
    loadError: serverLoadError,
    actionError: serverActionError,
    busyOrderId: busyServerId,
    selectedId: selectedServerId,
    onSelect: setSelectedServerId,
    onApprove: (o: ServerOrder) => handleServerDecision(o, 'accept'),
    onReject: (o: ServerOrder) => handleServerDecision(o, 'reject'),
    onCreateManual: handleCreateManualOrder,
    onAddItems: handleAddServerItems,
    onCheckout: (o: ServerOrder) => setCheckoutServerOrder(o),
  };

  return (
    <div className={`min-h-screen bg-gray-50 text-gray-800 font-sans`}>
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white/80 backdrop-blur-md border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-3 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 bg-gradient-to-tr from-orange-500 to-red-500 rounded-xl flex items-center justify-center text-white text-xl shadow-lg shadow-orange-200">
              🍽️
            </div>
            <div>
                <h1 className="font-extrabold text-xl text-gray-800 tracking-tight">{t.appTitle}</h1>
                <p className="text-xs text-gray-500 font-medium">{t.appSubtitle}</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={() => setShowSettings(true)} className="p-2.5 rounded-xl bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors">
              <SettingsIcon size={20} />
            </button>
            {totalItemsInCart > 0 && !selectedServerOrder && (
              <button onClick={() => setShowCart(true)} className="rounded-xl bg-gray-100 px-3 py-2 text-sm text-gray-700">
                سلة محلية ({totalItemsInCart})
              </button>
            )}
            <button
                onClick={() => setView('orders')}
                className="relative bg-gray-900 text-white px-5 py-2.5 rounded-xl font-bold hover:bg-gray-800 transition-all flex items-center gap-2 shadow-xl shadow-gray-200 active:scale-95"
                >
                <ShoppingCart size={20} />
                <span className="hidden sm:inline">الطلبات</span>
                {serverOrders.filter(o => o.status === 'pending' || o.status === 'accepted').length > 0 && (
                <span className="absolute -top-2 -right-2 bg-red-500 text-white w-6 h-6 rounded-full flex items-center justify-center text-xs border-2 border-white animate-pulse">
                  {serverOrders.filter(o => o.status === 'pending' || o.status === 'accepted').length}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="max-w-7xl mx-auto px-4 overflow-x-auto scrollbar-hide">
            <div className="flex gap-6 border-b border-gray-100">
                <button onClick={() => setView('menu')} className={`py-3 px-2 font-bold text-sm border-b-2 transition-colors whitespace-nowrap ${view === 'menu' ? 'border-orange-500 text-orange-600' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>📋 {t.menu}</button>
                <button onClick={() => setView('sales')} className={`py-3 px-2 font-bold text-sm border-b-2 transition-colors whitespace-nowrap ${view === 'sales' ? 'border-orange-500 text-orange-600' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>📈 {t.sales}</button>
                <button onClick={() => setView('orders')} className={`py-3 px-2 font-bold text-sm border-b-2 transition-colors whitespace-nowrap ${view === 'orders' ? 'border-orange-500 text-orange-600' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>🕐 {t.orders}</button>
                <button onClick={() => setView('history')} className={`py-3 px-2 font-bold text-sm border-b-2 transition-colors whitespace-nowrap ${view === 'history' ? 'border-orange-500 text-orange-600' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>📜 {t.history}</button>
                <button onClick={() => setView('qr')} className={`py-3 px-2 font-bold text-sm border-b-2 transition-colors whitespace-nowrap ${view === 'qr' ? 'border-orange-500 text-orange-600' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>📱 طاولات QR</button>

                <div className="ms-auto flex items-center gap-2 py-2">
                    <button onClick={() => setShowDiscounts(true)} className="px-3 py-1.5 text-xs font-bold bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition-colors">🏷️ {t.discounts}</button>
                    <button onClick={() => setShowAddItem(true)} className="px-3 py-1.5 text-xs font-bold bg-green-50 text-green-600 rounded-lg hover:bg-green-100 transition-colors">➕ {t.addItem}</button>
                </div>
            </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        {view === 'menu' && (
          <MenuView
            categories={CATEGORIES}
            menuItems={menuItems}
            currentOrder={currentOrder}
            discounts={discounts}
            showLimitedMenu={settings.showLimitedMenu}
            language={language}
            serverTarget={selectedServerOrder}
            onAddToServerOrder={(publishedId, qty) => {
              if (selectedServerOrder) handleAddServerItems(selectedServerOrder.id, publishedId, qty);
            }}
            onUpdateOrder={handleUpdateOrder}
            onEditItem={(item) => {
                const newItems = menuItems.map(i => i.id === item.id ? item : i);
                handleUpdateMenuItems(newItems);
            }}
            onDeleteItem={(id) => handleUpdateMenuItems(menuItems.filter(i => i.id !== id))}
            onToggleFavorite={(id) => handleUpdateMenuItems(menuItems.map(i => i.id === id ? { ...i, isFavorite: !i.isFavorite } : i))}
            onMoveItem={(cat, idx, dir) => {
                const catItems = menuItems.filter(i => i.category === cat).sort((a,b) => (a.order||0) - (b.order||0));
                if (idx < 0 || idx >= catItems.length) return;
                const item = catItems[idx];
                const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
                if(swapIdx < 0 || swapIdx >= catItems.length) return;
                const swapItem = catItems[swapIdx];

                const updatedItems = menuItems.map(i => {
                    if (i.id === item.id) return { ...i, order: swapItem.order ?? swapIdx };
                    if (i.id === swapItem.id) return { ...i, order: item.order ?? idx };
                    return i;
                });
                handleUpdateMenuItems(updatedItems);
            }}
          />
        )}

        {view === 'sales' && (
          <SalesView
            analytics={
                (() => {
                    const dateOrders = unifiedReportingOrders.filter(o => o.dateOnly === selectedSalesDate && o.status !== 'cancelled');
                    const totalSales = dateOrders.reduce((s, o) => s + o.total, 0);
                    const paymentBreakdown: any = { cash: 0, pix: 0, ifood_card: 0, cartao: 0 };
                    dateOrders.forEach(o => paymentBreakdown[o.paymentMethod] = (paymentBreakdown[o.paymentMethod] || 0) + o.total);

                    const itemsSold: any = {};
                    dateOrders.forEach(o => o.items.forEach(i => {
                        if(!itemsSold[i.name]) itemsSold[i.name] = { quantity: 0, total: 0 };
                        itemsSold[i.name].quantity += i.quantity;
                        itemsSold[i.name].total += i.price * i.quantity;
                    }));

                    const deliveryCount = dateOrders.filter(o => o.needsDelivery).length;
                    const deliveryCost = settings.dailyMotorcycleCost + (deliveryCount * settings.perDeliveryCost);

                    const sourceBreakdown: any = {};
                    dateOrders.forEach(o => sourceBreakdown[o.orderSource] = (sourceBreakdown[o.orderSource]||0)+1);

                    const typeBreakdown: any = {};
                    dateOrders.forEach(o => typeBreakdown[o.orderType] = (typeBreakdown[o.orderType]||0)+1);

                    return {
                        date: selectedSalesDate,
                        totalSales,
                        paymentBreakdown,
                        itemsSold,
                        deliveryCount,
                        deliveryCost,
                        netProfit: totalSales - deliveryCost,
                        ordersCount: dateOrders.length,
                        sourceBreakdown,
                        typeBreakdown,
                        cancelledCount: unifiedReportingOrders.filter(o => o.dateOnly === selectedSalesDate && o.status === 'cancelled').length
                    };
                })()
            }
            settings={settings}
            language={language}
            onExportSales={() => {
                alert('Export functionality hooked up in helper');
            }}
            selectedDate={selectedSalesDate}
            onDateChange={setSelectedSalesDate}
            availableDates={([...new Set(unifiedReportingOrders.map(o => o.dateOnly))] as string[]).sort((a,b) => {
                 const [da, ma, ya] = a.split('/').map(Number);
                 const [db, mb, yb] = b.split('/').map(Number);
                 return new Date(yb, mb-1, db).getTime() - new Date(ya, ma-1, da).getTime();
            })}
          />
        )}

        {view === 'orders' && (
          <>
            {/* Primary multi-order queue: order cards, approve/reject, per-order checkout */}
            <OrderInbox {...inboxProps} />
            <h2 style={{ margin: '32px 0 8px', fontSize: 18, color: '#374151' }}>المبيعات المحلية القديمة (Legacy)</h2>
            <OrdersView
            orders={completedOrders}
            language={language}
            onToggleStatus={(id) => {
                const updated = completedOrders.map(o => o.id === id ? { ...o, status: (o.status === 'cancelled' ? 'completed' : 'cancelled') as any } : o);
                handleUpdateOrders(updated);
            }}
            onDelete={(id) => {
                if(confirm(t.confirmDelete)) {
                    handleUpdateOrders(completedOrders.filter(o => o.id !== id));
                }
            }}
            onUpdateItemQty={(oId, iId, qty) => {
                const updated = completedOrders.map(o => {
                    if (o.id !== oId) return o;
                    const items = o.items.map(i => i.id === iId ? { ...i, quantity: qty } : i).filter(i => i.quantity > 0);
                    const total = items.reduce((s, i) => s + (i.price * i.quantity), 0) + (o.needsDelivery ? 10 : 0);
                    return { ...o, items, total };
                });
                handleUpdateOrders(updated);
            }}
          />
          </>
        )}

        {view === 'history' && (
          <HistoryView
            language={language}
            records={(() => {
                const recs: Record<string, DailySalesRecord> = {};
                const dates = [...new Set(unifiedReportingOrders.map(o => o.dateOnly))] as string[];
                dates.forEach(d => {
                    const dateOrders = unifiedReportingOrders.filter(o => o.dateOnly === d && o.status !== 'cancelled');
                    const totalSales = dateOrders.reduce((s, o) => s + o.total, 0);
                    const deliveryCount = dateOrders.filter(o => o.needsDelivery).length;
                    const deliveryCost = settings.dailyMotorcycleCost + (deliveryCount * settings.perDeliveryCost);
                    recs[d] = {
                        date: d,
                        totalSales,
                        ordersCount: dateOrders.length,
                        deliveryCount,
                        deliveryCost,
                        netProfit: totalSales - deliveryCost,
                        itemsSold: {},
                        paymentBreakdown: {},
                        sourceBreakdown: {},
                        typeBreakdown: {},
                        cancelledCount: 0,
                        savedAt: new Date().toLocaleString()
                    } as DailySalesRecord;
                });
                return recs;
            })()}
          />
        )}

        {/* QR tables + the same authenticated order queue. Pending guest orders
            are never counted as paid and never inserted into local sales. */}
        {view === 'qr' && <QRPanel menuItems={menuItems} inbox={inboxProps} paidServerCount={paidServerCount} onMetaChange={refreshInboxMeta} />}
      </main>

      {/* Modals */}
      {showAddItem && <AddItemModal language={language} showSpecialCategory={settings.showLimitedMenu} onClose={() => setShowAddItem(false)} onAdd={handleAddItem} />}
      {showCart && (
        <CartModal
          items={currentOrder}
          discounts={discounts}
          language={language}
          onClose={() => setShowCart(false)}
          onUpdateQty={handleUpdateOrder}
          onRemove={handleRemoveFromCart}
          onCheckout={() => { setShowCart(false); setShowCheckout(true); }}
        />
      )}
      {checkoutServerOrder && (
        <CheckoutModal
          language={language}
          serverOrder={{ id: checkoutServerOrder.id, label: `${checkoutServerOrder.guestName} — ${checkoutServerOrder.tableLabel}`, total: checkoutServerOrder.total }}
          onCancel={() => setCheckoutServerOrder(null)}
          onCompleteServer={(method) => handleCheckoutServerOrder(checkoutServerOrder, method)}
        />
      )}
      {showCheckout && !checkoutServerOrder && <CheckoutModal language={language} onCancel={() => setShowCheckout(false)} onComplete={handleCheckout} />}
      {showSettings && <SettingsModal settings={settings} onSave={handleUpdateSettings} onClose={() => setShowSettings(false)} onExport={handleExport} onImport={handleImport} />}
      {showDiscounts && <DiscountsModal language={language} items={menuItems} discounts={discounts} onSave={handleUpdateDiscounts} onClose={() => setShowDiscounts(false)} />}
    </div>
  );
};

export default App;