
import React, { useState, useMemo } from 'react';
import { Order, Language } from '../../types';
import { translations } from '../../utils/translations';
import { Trash, RefreshCcw, Check, ShoppingBag, Clock, Calendar, ArrowUpDown } from 'lucide-react';

interface OrdersViewProps {
  orders: Order[];
  onToggleStatus: (id: number) => void;
  onDelete: (id: number) => void;
  onUpdateItemQty: (orderId: number, itemId: number, qty: number) => void;
  language: Language;
}

const OrdersView: React.FC<OrdersViewProps> = ({ orders, onToggleStatus, onDelete, onUpdateItemQty, language }) => {
  const t = translations[language];

  const [filter, setFilter] = useState<'completed' | 'cancelled'>('completed');
  const [editingItem, setEditingItem] = useState<{oId: number, iId: number} | null>(null);
  const [tempQty, setTempQty] = useState('');

  // Filtering & Sorting State
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [sortOption, setSortOption] = useState<'newest' | 'oldest' | 'highest' | 'lowest'>('newest');

  const handleCommitQty = (oId: number, iId: number) => {
      const q = parseInt(tempQty);
      if(!isNaN(q)) {
          onUpdateItemQty(oId, iId, q);
      }
      setEditingItem(null);
  }

  // Helper to parse DD/MM/YYYY
  const parseDate = (dateStr: string) => {
      const [day, month, year] = dateStr.split('/').map(Number);
      return new Date(year, month - 1, day);
  };

  const filteredAndSortedOrders = useMemo(() => {
    // 1. Filter by Status
    let result = orders.filter(o => filter === 'completed' ? o.status !== 'cancelled' : o.status === 'cancelled');

    // 2. Filter by Date Range
    if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        result = result.filter(o => parseDate(o.dateOnly) >= start);
    }

    if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        result = result.filter(o => parseDate(o.dateOnly) <= end);
    }

    // 3. Sort
    return result.sort((a, b) => {
        switch (sortOption) {
            case 'newest':
                return b.id - a.id;
            case 'oldest':
                return a.id - b.id;
            case 'highest':
                return b.total - a.total;
            case 'lowest':
                return a.total - b.total;
            default:
                return 0;
        }
    });
  }, [orders, filter, startDate, endDate, sortOption]);

  return (
    <div className="space-y-6 pb-20">

      {/* Controls Bar */}
      <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex flex-col xl:flex-row gap-4 justify-between items-center sticky top-[72px] z-10">
        {/* Status Filter */}
        <div className="flex gap-2 p-1 bg-gray-50 rounded-xl w-full xl:w-auto border border-gray-200">
            <button
                onClick={() => setFilter('completed')}
                className={`flex-1 xl:flex-none px-4 py-2 rounded-lg font-bold text-sm transition-all flex items-center justify-center gap-2 ${filter === 'completed' ? 'bg-white text-green-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
            >
                <Check size={16} /> {t.completed}
            </button>
            <button
                onClick={() => setFilter('cancelled')}
                className={`flex-1 xl:flex-none px-4 py-2 rounded-lg font-bold text-sm transition-all flex items-center justify-center gap-2 ${filter === 'cancelled' ? 'bg-white text-red-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
            >
                <Trash size={16} /> {t.cancelled}
            </button>
        </div>

        {/* Advanced Filters */}
        <div className="flex flex-col sm:flex-row gap-3 w-full xl:w-auto">
             <div className="flex items-center gap-2 bg-gray-50 p-2 rounded-xl border border-gray-200 flex-1">
                <Calendar size={16} className="text-gray-400" />
                <input
                    type="date"
                    className="bg-transparent text-sm outline-none w-full text-gray-600 font-medium"
                    placeholder={t.fromDate}
                    value={startDate}
                    onChange={e => setStartDate(e.target.value)}
                />
                <span className="text-gray-300">|</span>
                <input
                    type="date"
                    className="bg-transparent text-sm outline-none w-full text-gray-600 font-medium"
                    placeholder={t.toDate}
                    value={endDate}
                    onChange={e => setEndDate(e.target.value)}
                />
             </div>

             <div className="flex items-center gap-2 bg-gray-50 p-2 rounded-xl border border-gray-200 min-w-[180px]">
                <ArrowUpDown size={16} className="text-gray-400" />
                <select
                    value={sortOption}
                    onChange={e => setSortOption(e.target.value as any)}
                    className="bg-transparent text-sm outline-none w-full font-bold text-gray-700 cursor-pointer"
                >
                    <option value="newest">🆕 {t.newest}</option>
                    <option value="oldest">📅 {t.oldest}</option>
                    <option value="highest">💰 {t.highestPrice}</option>
                    <option value="lowest">📉 {t.lowestPrice}</option>
                </select>
             </div>
        </div>
      </div>

      {filteredAndSortedOrders.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <ShoppingBag size={48} className="mb-4 opacity-20" />
            <p>{t.noItems}</p>
            {(startDate || endDate) && (
                <button onClick={() => { setStartDate(''); setEndDate(''); }} className="mt-2 text-blue-500 text-sm hover:underline font-bold">
                    Clear Filters
                </button>
            )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredAndSortedOrders.map(order => (
                <div key={order.id} className={`bg-white rounded-2xl p-5 shadow-sm border border-gray-100 relative group transition-all ${order.status === 'cancelled' ? 'opacity-70 grayscale-[0.5]' : ''}`}>
                    <div className="flex justify-between items-start mb-4">
                        <div>
                            <div className="flex items-center gap-2">
                                <span className="font-bold text-lg text-gray-800">#{order.id.toString().slice(-4)}</span>
                                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${order.status === 'cancelled' ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'}`}>
                                    {order.status === 'cancelled' ? t.cancelled : t.completed}
                                </span>
                            </div>
                            <div className="flex items-center gap-1 text-xs text-gray-500 mt-1">
                                <Clock size={12} />
                                {order.date}
                            </div>
                        </div>
                        <div className="text-right">
                            <span className="block font-bold text-xl text-gray-800">{t.currency} {order.total.toFixed(2)}</span>
                            <span className="text-xs text-gray-500">{order.paymentMethod}</span>
                        </div>
                    </div>

                    <div className="flex flex-wrap gap-2 mb-4">
                        <span className="px-2 py-1 bg-blue-50 text-blue-700 text-xs rounded-md font-medium">
                            {order.orderType === 'dine_in' ? t.dineIn : order.orderType === 'takeaway' ? t.takeaway : t.delivery}
                        </span>
                        <span className="px-2 py-1 bg-purple-50 text-purple-700 text-xs rounded-md font-medium">
                            {order.orderSource}
                        </span>
                    </div>

                    <div className="bg-gray-50 rounded-xl p-3 mb-4 space-y-2 max-h-40 overflow-y-auto custom-scrollbar">
                        {order.items.map((item, idx) => (
                            <div key={`${order.id}-${item.id}-${idx}`} className="flex justify-between items-center text-sm">
                                <div className="flex items-center gap-2">
                                    <span className="font-medium text-gray-700">{item.name}</span>
                                    {order.status !== 'cancelled' && (
                                        <div className="flex items-center bg-white rounded border border-gray-200 h-6">
                                            {editingItem?.oId === order.id && editingItem?.iId === item.id ? (
                                                <input
                                                    autoFocus
                                                    className="w-10 text-center text-xs outline-none bg-transparent"
                                                    value={tempQty}
                                                    onChange={e => setTempQty(e.target.value)}
                                                    onBlur={() => handleCommitQty(order.id, item.id)}
                                                    onKeyDown={e => e.key === 'Enter' && handleCommitQty(order.id, item.id)}
                                                />
                                            ) : (
                                                <button
                                                    className="w-6 text-center font-bold hover:bg-gray-100 transition-colors"
                                                    onClick={() => { setEditingItem({oId: order.id, iId: item.id}); setTempQty(String(item.quantity)); }}
                                                >
                                                    {item.quantity}x
                                                </button>
                                            )}
                                        </div>
                                    )}
                                    {order.status === 'cancelled' && <span className="text-gray-500">x{item.quantity}</span>}
                                </div>
                                <span className="text-gray-500">{t.currency} {(item.price * item.quantity).toFixed(2)}</span>
                            </div>
                        ))}
                    </div>

                    {order.notes && (
                        <div className="mb-4 p-2 bg-yellow-50 text-yellow-800 text-xs rounded-lg border border-yellow-100">
                            📝 {order.notes}
                        </div>
                    )}

                    <div className="flex gap-2 pt-2 border-t">
                        <button
                            onClick={() => onToggleStatus(order.id)}
                            className={`flex-1 py-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-colors ${order.status === 'cancelled' ? 'bg-green-50 text-green-600 hover:bg-green-100' : 'bg-yellow-50 text-yellow-600 hover:bg-yellow-100'}`}
                        >
                            {order.status === 'cancelled' ? <><RefreshCcw size={16}/> {t.restore}</> : <><Trash size={16}/> {t.cancelled}</>}
                        </button>
                        <button
                            onClick={() => onDelete(order.id)}
                            className="p-2 rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition-colors"
                            title={t.delete}
                        >
                            <Trash size={18} />
                        </button>
                    </div>
                </div>
            ))}
        </div>
      )}
    </div>
  );
};

export default OrdersView;