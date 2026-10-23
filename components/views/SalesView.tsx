
import React from 'react';
import { SalesAnalytics, Settings, Language } from '../../types';
import { translations } from '../../utils/translations';
import { BarChart3, TrendingUp, Package, Truck, Wallet, FileText, Calendar } from 'lucide-react';

interface SalesViewProps {
  analytics: SalesAnalytics;
  settings: Settings;
  onExportSales: () => void;
  selectedDate: string;
  onDateChange: (date: string) => void;
  availableDates: string[];
  language: Language;
}

const SalesView: React.FC<SalesViewProps> = ({
  analytics, settings, onExportSales, selectedDate, onDateChange, availableDates, language
}) => {
  const t = translations[language];

  // Helper to parse DD/MM/YYYY to YYYY-MM-DD for input[type="date"]
  const getInputValue = (dateStr: string) => {
      if(!dateStr) return '';
      const [day, month, year] = dateStr.split('/');
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // Helper to parse YYYY-MM-DD to DD/MM/YYYY
  const handleInputDate = (val: string) => {
      if(!val) return;
      const [year, month, day] = val.split('-');
      onDateChange(`${day}/${month}/${year}`);
  }

  return (
    <div className="space-y-6 pb-10">
      {/* Controls */}
      <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 flex flex-col md:flex-row justify-between gap-4">
        <div>
            <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
                <BarChart3 className="text-green-600" /> {t.salesReport}
            </h2>
            <p className="text-sm text-gray-500 mt-1">{t.date}: {selectedDate}</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 items-center">
            <div className="relative">
                <input
                    type="date"
                    value={getInputValue(selectedDate)}
                    onChange={(e) => handleInputDate(e.target.value)}
                    className="pl-4 pr-10 py-2 border rounded-xl bg-gray-50 outline-none focus:ring-2 focus:ring-green-500"
                />
                <Calendar className="absolute right-3 top-2.5 text-gray-400 pointer-events-none" size={18} />
            </div>
            <button onClick={onExportSales} className="bg-green-600 text-white px-5 py-2 rounded-xl font-bold hover:bg-green-700 flex items-center gap-2 shadow-lg shadow-green-100 transition-all">
                <FileText size={18} /> {t.exportData}
            </button>
        </div>
      </div>

      {/* Date Tags */}
      {availableDates.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
              {availableDates.slice(0, 10).map(d => (
                  <button
                    key={d}
                    onClick={() => onDateChange(d)}
                    className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${selectedDate === d ? 'bg-gray-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-100 border'}`}
                  >
                      {d}
                  </button>
              ))}
          </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-green-100 relative overflow-hidden">
            <div className="absolute -right-4 -top-4 w-20 h-20 bg-green-50 rounded-full blur-2xl"></div>
            <p className="text-sm text-gray-500 font-medium mb-1">{t.totalSales}</p>
            <p className="text-3xl font-bold text-gray-800">{t.currency} {analytics.totalSales.toFixed(2)}</p>
            <TrendingUp className="absolute bottom-4 left-4 text-green-500 opacity-20" size={40} />
        </div>
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-blue-100 relative overflow-hidden">
            <p className="text-sm text-gray-500 font-medium mb-1">{t.completedOrders}</p>
            <p className="text-3xl font-bold text-gray-800">{analytics.ordersCount}</p>
            {analytics.cancelledCount > 0 && <span className="text-xs text-red-500 bg-red-50 px-2 py-0.5 rounded-full mt-2 inline-block">{t.cancelled}: {analytics.cancelledCount}</span>}
            <Package className="absolute bottom-4 left-4 text-blue-500 opacity-20" size={40} />
        </div>
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-orange-100 relative overflow-hidden">
            <p className="text-sm text-gray-500 font-medium mb-1">{t.delivery}</p>
            <p className="text-3xl font-bold text-gray-800">{analytics.deliveryCount}</p>
            <p className="text-xs text-orange-600 mt-1">{t.currency} {analytics.deliveryCost.toFixed(2)}</p>
            <Truck className="absolute bottom-4 left-4 text-orange-500 opacity-20" size={40} />
        </div>
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-purple-100 relative overflow-hidden">
            <p className="text-sm text-gray-500 font-medium mb-1">{t.netProfit}</p>
            <p className={`text-3xl font-bold ${analytics.netProfit >= 0 ? 'text-purple-600' : 'text-red-600'}`}>{t.currency} {analytics.netProfit.toFixed(2)}</p>
            <Wallet className="absolute bottom-4 left-4 text-purple-500 opacity-20" size={40} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Payment Breakdown */}
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
            <h3 className="font-bold text-gray-800 mb-4 flex items-center gap-2">💳 {t.paymentBreakdown}</h3>
            <div className="space-y-3">
                <div className="flex justify-between items-center p-3 bg-green-50/50 rounded-xl">
                    <span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-green-500"></span> {t.cash}</span>
                    <span className="font-bold font-mono">{t.currency} {analytics.paymentBreakdown.cash.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center p-3 bg-blue-50/50 rounded-xl">
                    <span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-blue-500"></span> Pix</span>
                    <span className="font-bold font-mono">{t.currency} {analytics.paymentBreakdown.pix.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center p-3 bg-indigo-50/50 rounded-xl">
                    <span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-indigo-500"></span> {t.card}</span>
                    <span className="font-bold font-mono">{t.currency} {analytics.paymentBreakdown.cartao.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center p-3 bg-red-50/50 rounded-xl">
                    <span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-red-500"></span> iFood</span>
                    <span className="font-bold font-mono">{t.currency} {analytics.paymentBreakdown.ifood_card.toFixed(2)}</span>
                </div>
            </div>
        </div>

        {/* Sources & Types */}
        <div className="space-y-6">
            <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
                <h3 className="font-bold text-gray-800 mb-4">📍 {t.orderSource}</h3>
                <div className="flex flex-wrap gap-2">
                    {Object.entries(analytics.sourceBreakdown).map(([key, val]) => (
                        <span key={key} className="px-3 py-1 bg-gray-100 rounded-lg text-sm text-gray-700 font-medium flex items-center gap-2">
                            {key === 'salon' ? t.dineIn : key === 'whatsapp' ? 'WhatsApp' : key === 'ifood' ? 'iFood' : key}
                            <span className="bg-white px-2 py-0.5 rounded text-xs shadow-sm">{val}</span>
                        </span>
                    ))}
                </div>
            </div>

            <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
                <h3 className="font-bold text-gray-800 mb-4">🍽️ {t.orderType}</h3>
                <div className="flex flex-wrap gap-2">
                    {Object.entries(analytics.typeBreakdown).map(([key, val]) => (
                        <span key={key} className="px-3 py-1 bg-gray-100 rounded-lg text-sm text-gray-700 font-medium flex items-center gap-2">
                            {key === 'dine_in' ? t.dineIn : key === 'takeaway' ? t.takeaway : t.delivery}
                            <span className="bg-white px-2 py-0.5 rounded text-xs shadow-sm">{val}</span>
                        </span>
                    ))}
                </div>
            </div>
        </div>
      </div>

      {/* Items Sold */}
      <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
        <h3 className="font-bold text-gray-800 mb-4">🍔 {t.itemsSold}</h3>
        {Object.keys(analytics.itemsSold).length === 0 ? (
            <div className="text-center py-8 text-gray-400">{t.noItems}</div>
        ) : (
            <div className="overflow-x-auto">
                <table className="w-full text-start">
                    <thead>
                        <tr className="border-b text-gray-500 text-sm">
                            <th className="pb-3 font-medium text-start">{t.itemName}</th>
                            <th className="pb-3 font-medium text-start">{t.quantity}</th>
                            <th className="pb-3 font-medium text-start">{t.total}</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                        {Object.entries(analytics.itemsSold)
                            .sort((a, b) => (b[1] as {quantity: number}).quantity - (a[1] as {quantity: number}).quantity)
                            .map(([name, data]) => {
                                const d = data as { quantity: number; total: number };
                                return (
                                <tr key={name} className="group hover:bg-gray-50 transition-colors">
                                    <td className="py-3 font-medium text-gray-800">{name}</td>
                                    <td className="py-3 text-gray-600">{d.quantity}</td>
                                    <td className="py-3 font-mono text-green-600">{t.currency} {d.total.toFixed(2)}</td>
                                </tr>
                                );
                            })}
                    </tbody>
                </table>
            </div>
        )}
      </div>
    </div>
  );
};

export default SalesView;