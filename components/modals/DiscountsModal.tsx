import React, { useState } from 'react';
import { MenuItem, Discount, Language } from '../../types';
import { translations } from '../../utils/translations';
import { X, Trash2, Pause, Play, Plus } from 'lucide-react';

interface DiscountsModalProps {
  items: MenuItem[];
  discounts: Discount[];
  onSave: (discounts: Discount[]) => void;
  onClose: () => void;
  language: Language;
}

const DiscountsModal: React.FC<DiscountsModalProps> = ({ items, discounts, onSave, onClose, language }) => {
  const [localDiscounts, setLocalDiscounts] = useState<Discount[]>([...discounts]);
  const [newDiscount, setNewDiscount] = useState<Partial<Discount>>({
    startDate: new Date().toISOString().split('T')[0],
    endDate: new Date().toISOString().split('T')[0],
    active: true
  });

  const t = translations[language];

  const addDiscount = () => {
    if (!newDiscount.itemId || !newDiscount.discountPrice) {
      alert('Error');
      return;
    }
    const item = items.find(i => i.id === Number(newDiscount.itemId));

    if (item && Number(newDiscount.discountPrice) >= item.price) {
      alert('Discount price must be lower than original price');
      return;
    }
    const discount: Discount = {
      id: Date.now(),
      itemId: Number(newDiscount.itemId),
      discountPrice: Number(newDiscount.discountPrice),
      startDate: newDiscount.startDate!,
      endDate: newDiscount.endDate!,
      active: true
    };

    setLocalDiscounts([...localDiscounts, discount]);
    setNewDiscount({
        ...newDiscount,
        itemId: undefined,
        discountPrice: undefined
    });
  };

  const toggleDiscount = (id: number) => {
    setLocalDiscounts(localDiscounts.map(d => d.id === id ? { ...d, active: !d.active } : d));
  };

  const deleteDiscount = (id: number) => {
    setLocalDiscounts(localDiscounts.filter(d => d.id !== id));
  };

  const handleSave = () => {
    onSave(localDiscounts);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 max-w-4xl w-full shadow-2xl animate-in fade-in zoom-in duration-200" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-red-600 flex items-center gap-2">
            <span>🏷️</span> {t.discountMng}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={24} />
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Form Section */}
            <div className="bg-white p-5 rounded-xl border-2 border-gray-100 shadow-sm h-fit">
                <h3 className="font-bold text-gray-800 mb-4 flex items-center gap-2">
                    <Plus size={18} className="text-red-500" /> {t.newDiscount}
                </h3>
                <div className="space-y-4">
                    <div>
                        <label className="block text-xs font-bold text-gray-500 mb-1">{t.itemName}</label>
                        <select
                            value={newDiscount.itemId || ''}
                            onChange={(e) => setNewDiscount({ ...newDiscount, itemId: Number(e.target.value) })}
                            className="w-full p-2 border rounded-lg bg-white"
                        >
                            <option value="">...</option>
                            {items.map(item => (
                                <option key={item.id} value={item.id}>{item.name} ({t.currency} {item.price.toFixed(2)})</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-gray-500 mb-1">{t.price} ({t.currency})</label>
                        <input
                            type="number"
                            step="0.01"
                            value={newDiscount.discountPrice || ''}
                            onChange={(e) => setNewDiscount({ ...newDiscount, discountPrice: parseFloat(e.target.value) })}
                            className="w-full p-2 border rounded-lg bg-white"
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label className="block text-xs font-bold text-gray-500 mb-1">{t.fromDate}</label>
                            <input
                                type="date"
                                value={newDiscount.startDate}
                                onChange={(e) => setNewDiscount({ ...newDiscount, startDate: e.target.value })}
                                className="w-full p-2 border rounded-lg bg-white text-sm"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-gray-500 mb-1">{t.toDate}</label>
                            <input
                                type="date"
                                value={newDiscount.endDate}
                                onChange={(e) => setNewDiscount({ ...newDiscount, endDate: e.target.value })}
                                className="w-full p-2 border rounded-lg bg-white text-sm"
                            />
                        </div>
                    </div>

                    {newDiscount.itemId && newDiscount.discountPrice && (
                        <div className="bg-blue-100 text-blue-800 p-2 rounded text-xs font-bold text-center">
                            {t.currency} {(items.find(i => i.id === newDiscount.itemId)?.price! - newDiscount.discountPrice).toFixed(2)}
                        </div>
                    )}

                    <button onClick={addDiscount} className="w-full bg-red-600 text-white py-3 rounded-lg font-bold hover:bg-red-700 transition-colors">
                        {t.add}
                    </button>
                </div>
            </div>

            {/* List Section */}
            <div className="lg:col-span-2 flex flex-col h-[500px]">
                <h3 className="font-bold text-gray-700 mb-4">{t.discounts} ({localDiscounts.length})</h3>
                <div className="flex-1 overflow-y-auto space-y-3 pr-2">
                    {localDiscounts.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-gray-400">
                            <span className="text-4xl mb-2">🏷️</span>
                            <p>{t.noItems}</p>
                        </div>
                    ) : (
                        localDiscounts.map(discount => {
                            const item = items.find(i => i.id === discount.itemId);
                            if (!item) return null;
                            const nowTime = new Date().getTime();
                            const startTime = new Date(discount.startDate).getTime();
                            const endTime = new Date(discount.endDate).setHours(23, 59, 59, 999);

                            const isActiveTime = nowTime >= startTime && nowTime <= endTime;

                            return (
                                <div key={discount.id} className={`p-4 rounded-xl border-l-4 shadow-sm bg-white ${discount.active && isActiveTime ? 'border-green-500' : 'border-gray-300 opacity-75'}`}>
                                    <div className="flex justify-between items-start">
                                        <div>
                                            <h4 className="font-bold text-lg text-gray-800">{item.name}</h4>
                                            <div className="flex gap-3 text-sm mt-1">
                                                <span className="text-gray-400 line-through">{t.currency} {item.price.toFixed(2)}</span>
                                                <span className="text-red-600 font-bold">{t.currency} {discount.discountPrice.toFixed(2)}</span>
                                            </div>
                                            <p className="text-xs text-gray-500 mt-2">📅 {discount.startDate} ➝ {discount.endDate}</p>
                                        </div>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => toggleDiscount(discount.id)}
                                                className={`p-2 rounded-lg text-white transition-colors ${discount.active ? 'bg-yellow-500 hover:bg-yellow-600' : 'bg-green-500 hover:bg-green-600'}`}
                                            >
                                                {discount.active ? <Pause size={16}/> : <Play size={16}/>}
                                            </button>
                                            <button
                                                onClick={() => deleteDiscount(discount.id)}
                                                className="p-2 rounded-lg bg-red-100 text-red-600 hover:bg-red-200 transition-colors"
                                            >
                                                <Trash2 size={16}/>
                                            </button>
                                        </div>
                                    </div>
                                    <div className="mt-2">
                                        <span className={`text-[10px] px-2 py-1 rounded-full font-bold ${discount.active && isActiveTime ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                                            {discount.active && isActiveTime ? t.active : t.inactive}
                                        </span>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        </div>

        <div className="flex gap-3 mt-6 pt-4 border-t">
            <button onClick={onClose} className="flex-1 bg-gray-100 text-gray-700 py-3 rounded-xl font-bold hover:bg-gray-200 transition-colors">
                {t.cancel}
            </button>
            <button onClick={handleSave} className="flex-1 bg-red-600 text-white py-3 rounded-xl font-bold hover:bg-red-700 transition-colors shadow-lg shadow-red-200">
                {t.save}
            </button>
        </div>
      </div>
    </div>
  );
};

export default DiscountsModal;