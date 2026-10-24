
import React from 'react';
import { MenuItem, OrderItem, Language } from '../../types';
import { getItemPrice, SPECIAL_MENU_CATEGORY } from '../../utils/helpers';
import { translations } from '../../utils/translations';
import { ServerOrder, canAddItems } from '../../utils/qr/adminOrders';
import { formatBRL } from '../../utils/qr/helpers';
import { Edit2, Trash, Star, Plus, Minus, Zap } from 'lucide-react';

interface MenuViewProps {
  categories: string[];
  menuItems: MenuItem[];
  currentOrder: OrderItem[];
  discounts: any[];
  showLimitedMenu?: boolean;
  onUpdateOrder: (item: MenuItem, qty: number, mode?: 'delta' | 'set') => void;
  onEditItem: (item: MenuItem) => void;
  onDeleteItem: (id: number) => void;
  onToggleFavorite: (id: number) => void;
  onMoveItem: (category: string, index: number, direction: 'up' | 'down') => void;
  language: Language;
  /** Selected open server order (accepted/unpaid): adds go to it, not the local cart. */
  serverTarget?: ServerOrder | null;
  onAddToServerOrder?: (publishedItemId: string, quantity: number) => void;
}

const MenuView: React.FC<MenuViewProps> = ({
  categories, menuItems, currentOrder, discounts, showLimitedMenu, onUpdateOrder, onEditItem, onDeleteItem, onToggleFavorite, onMoveItem, language, serverTarget, onAddToServerOrder
}) => {
  const t = translations[language];
  const serverMode = !!(serverTarget && canAddItems(serverTarget) && onAddToServerOrder);

  const addItem = (item: MenuItem) => {
    if (serverMode) {
      // Explicit target: published menu item id; the SERVER resolves the price
      // from its published snapshot — local prices are never trusted.
      onAddToServerOrder!(String(item.id), 1);
    } else if (!serverTarget) {
      onUpdateOrder(item, 1);
    }
  };

  const renderItemCard = (item: MenuItem, index: number, cat: string, isFavSection: boolean = false, isSpecial: boolean = false) => {
    const currentPrice = getItemPrice(item, discounts);
    const hasDiscount = currentPrice < item.price;
    const inOrder = currentOrder.find(o => o.id === item.id);

    let cardClasses = `bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden transition-all duration-300 hover:-translate-y-1 hover:shadow-xl group relative flex flex-col`;

    if (isSpecial) {
        cardClasses += ' border-2 border-purple-400 bg-gradient-to-br from-purple-50 via-white to-purple-50';
    } else if (isFavSection) {
        cardClasses += ' border-yellow-200 bg-gradient-to-br from-yellow-50 to-white';
    }

    return (
      <div key={item.id} className={cardClasses}>

        {/* Badges */}
        <div className="absolute top-3 left-3 z-10 flex flex-col gap-1">
            {hasDiscount && (
                <span className="bg-red-500 text-white text-[10px] font-bold px-2 py-1 rounded-full shadow-sm">
                    %
                </span>
            )}
            {isSpecial && (
                <span className="bg-purple-600 text-white text-[10px] font-bold px-2 py-1 rounded-full shadow-sm flex items-center gap-1">
                    <Zap size={10} fill="currentColor" /> {t.specialMenu}
                </span>
            )}
        </div>
        <div className="absolute top-3 right-3 z-10">
             <button
                onClick={() => onToggleFavorite(item.id)}
                className={`p-1.5 rounded-full backdrop-blur-md transition-colors ${item.isFavorite ? 'bg-yellow-400 text-white' : 'bg-white/70 text-gray-400 hover:bg-white'}`}
            >
                <Star size={16} fill={item.isFavorite ? "currentColor" : "none"} />
            </button>
        </div>

        {/* Image */}
        <div className="h-40 w-full bg-gray-100 relative overflow-hidden">
            {item.image ? (
                <img src={item.image} alt={item.name} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" loading="lazy" />
            ) : (
                <div className={`w-full h-full flex items-center justify-center text-4xl ${isSpecial ? 'bg-purple-100 text-purple-300' : 'bg-orange-50 text-orange-200'}`}>
                    🍽️
                </div>
            )}

            {/* Admin Controls - Moved here to overlay image */}
            {!isFavSection && (
                <div className="absolute bottom-0 left-0 right-0 p-2 bg-black/60 backdrop-blur-sm translate-y-full group-hover:translate-y-0 transition-transform flex justify-around z-20">
                    <button onClick={() => onMoveItem(cat, index, 'up')} disabled={index === 0} className="p-1 text-white hover:text-blue-400 disabled:opacity-30">▲</button>
                    <button onClick={() => onMoveItem(cat, index, 'down')} className="p-1 text-white hover:text-blue-400 disabled:opacity-30">▼</button>
                    <button onClick={() => onEditItem(item)} className="p-1 text-white hover:text-blue-400"><Edit2 size={18} /></button>
                    <button onClick={() => onDeleteItem(item.id)} className="p-1 text-white hover:text-red-400"><Trash size={18} /></button>
                </div>
            )}
        </div>

        {/* Content */}
        <div className="p-4 flex-1 flex flex-col relative z-10 bg-transparent">
            <h3 className="font-bold text-gray-800 text-lg mb-1">{item.name}</h3>
            {item.description && <p className="text-gray-500 text-xs mb-3 line-clamp-2">{item.description}</p>}

            <div className="mt-auto">
                <div className="flex items-end gap-2 mb-4">
                    {hasDiscount ? (
                        <>
                            <span className="text-gray-400 text-sm line-through decoration-red-400">{t.currency} {item.price.toFixed(2)}</span>
                            <span className="text-xl font-bold text-red-600">{t.currency} {currentPrice.toFixed(2)}</span>
                        </>
                    ) : (
                        <span className="text-xl font-bold text-green-600">{t.currency} {currentPrice.toFixed(2)}</span>
                    )}
                </div>

                <div className="flex items-center justify-between gap-2 h-10">
                    {!serverTarget && inOrder ? (
                        <div className="flex items-center bg-gray-100 rounded-lg p-1 w-full justify-between h-full border border-gray-200">
                            <button onClick={() => onUpdateOrder(item, -1)} className="w-8 h-full flex items-center justify-center bg-white rounded-md shadow-sm text-red-500 hover:bg-red-50 active:scale-95 transition-all border border-gray-100"><Minus size={16} /></button>
                            <input
                                type="number"
                                min="1"
                                value={inOrder.quantity}
                                onFocus={(e) => e.target.select()}
                                onChange={(e) => {
                                    const val = parseInt(e.target.value);
                                    if (!isNaN(val)) {
                                        onUpdateOrder(item, val, 'set');
                                    }
                                }}
                                className="w-full flex-1 text-center font-bold text-gray-800 outline-none bg-transparent [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none text-lg"
                            />
                            <button onClick={() => onUpdateOrder(item, 1)} className="w-8 h-full flex items-center justify-center bg-white rounded-md shadow-sm text-green-500 hover:bg-green-50 active:scale-95 transition-all border border-gray-100"><Plus size={16} /></button>
                        </div>
                    ) : (
                        <button
                            onClick={() => addItem(item)}
                            disabled={!!serverTarget && !serverMode}
                            className={`w-full h-full text-white rounded-lg font-bold active:scale-95 transition-all shadow-lg flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed ${serverMode ? 'bg-blue-600 hover:bg-blue-700 shadow-blue-100' : isSpecial ? 'bg-purple-600 hover:bg-purple-700 shadow-purple-100' : 'bg-orange-600 hover:bg-orange-700 shadow-orange-100'}`}
                        >
                            <span>{serverMode ? '🎯' : '🛒'}</span> {serverTarget && !serverMode ? 'الطلب غير متاح للإضافة' : serverMode ? 'إضافة للطلب المحدد' : t.add}
                        </button>
                    )}
                </div>
            </div>
        </div>
      </div>
    );
  };

  const specialItems = showLimitedMenu ? menuItems.filter(i => i.category === SPECIAL_MENU_CATEGORY) : [];
  const favoriteItems = menuItems.filter(i => i.isFavorite && i.category !== SPECIAL_MENU_CATEGORY);

  return (
    <div className="space-y-8 pb-20">

      {/* Server order target banner: additions go to the selected order card */}
      {serverTarget && (
        <div className={`p-3 rounded-xl border text-sm font-bold ${serverMode ? 'bg-blue-50 border-blue-200 text-blue-800' : 'bg-gray-50 border-gray-200 text-gray-500'}`}>
          {serverMode
            ? <>🎯 الإضافة تذهب إلى طلب: {serverTarget.guestName}{serverTarget.tableLabel ? ` — ${serverTarget.tableLabel}` : ''} ({formatBRL(serverTarget.total)}). لإلغاء التوجيه، أغلق الطلب من تبويب الطلبات.</>
            : <>الطلب المحدد غير قابل للإضافة (معلّق أو مدفوع).</>
          }
        </div>
      )}

      {/* Special Limited Menu Section */}
      {showLimitedMenu && specialItems.length > 0 && (
        <section className="bg-gradient-to-r from-purple-100 via-white to-purple-100 p-4 rounded-3xl border-2 border-purple-300 shadow-xl shadow-purple-100 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-purple-300 rounded-full blur-[60px] opacity-30"></div>
            <div className="absolute bottom-0 left-0 w-32 h-32 bg-indigo-300 rounded-full blur-[60px] opacity-30"></div>

            <div className="flex items-center gap-2 mb-6 relative z-10">
                <span className="text-3xl animate-bounce">⚡</span>
                <div>
                    <h2 className="text-2xl font-extrabold text-purple-900">{t.specialMenu}</h2>
                    <p className="text-purple-600 text-xs font-bold">{t.limitedTime}</p>
                </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 relative z-10">
                {specialItems.map((item, idx) => renderItemCard(item, idx, SPECIAL_MENU_CATEGORY, false, true))}
            </div>
        </section>
      )}

      {/* Empty State for Special Menu if active but empty */}
      {showLimitedMenu && specialItems.length === 0 && (
          <div className="border-2 border-dashed border-purple-300 rounded-2xl p-6 text-center bg-purple-50">
             <h3 className="text-purple-700 font-bold">{t.specialMenu}</h3>
             <p className="text-xs text-purple-500 mb-2">{t.decoModeDesc}</p>
          </div>
      )}

      {favoriteItems.length > 0 && (
        <section>
            <div className="flex items-center gap-2 mb-4 bg-yellow-50 p-3 rounded-xl border border-yellow-100 w-fit">
                <span className="text-2xl">⭐</span>
                <h2 className="text-xl font-bold text-yellow-700">{t.favorites}</h2>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {favoriteItems.map((item, idx) => renderItemCard(item, idx, item.category, true))}
            </div>
        </section>
      )}

      {categories.map(cat => {
        const items = menuItems.filter(i => i.category === cat && i.category !== SPECIAL_MENU_CATEGORY).sort((a, b) => (a.order || 0) - (b.order || 0));
        if (items.length === 0) return null;
        return (
          <section key={cat}>
            <h2 className="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2 sticky top-[72px] bg-gray-50/90 backdrop-blur p-2 rounded-lg z-10 border-r-4 rtl:border-r-4 ltr:border-l-4 border-orange-500 rtl:pl-3 ltr:pr-3">
               {cat}
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {items.map((item, idx) => renderItemCard(item, idx, cat))}
            </div>
          </section>
        );
      })}

      {menuItems.length === 0 && !showLimitedMenu && (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <span className="text-6xl mb-4">🍽️</span>
            <p className="text-xl">{t.noItems}</p>
            <p className="text-sm">{t.addItem}</p>
        </div>
      )}
    </div>
  );
};

export default MenuView;
