import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Platform,
  TouchableOpacity,
} from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import HomeScreen from '../screens/HomeScreen';
import MyOrdersScreen from '../screens/MyOrdersScreen';
import CreateScreen from '../screens/CreateScreen';
import MyBidsScreen from '../screens/MyBidsScreen';
import ChatListScreen from '../screens/ChatListScreen';
import BidifyAIFab from '../components/BidifyAIFab';
import { useChatUnread } from '../context/ChatUnreadContext';

const Tab = createBottomTabNavigator();

const TAB_BG = '#242424';
const ACTIVE = '#FFFFFF';
const INACTIVE = '#A0A0A0';
const SELL_RING_COLORS = ['#4A90E2', '#50E3C2', '#F5A623'];
const ICON_SIZE = 24;

function TabBarIcon({ routeName, focused, color }) {
  const map = {
    Home: focused ? 'home' : 'home-outline',
    MyOrders: focused ? 'receipt' : 'receipt-outline',
    MyBids: focused ? 'hammer' : 'hammer-outline',
    Chats: focused ? 'chatbubble-ellipses' : 'chatbubble-ellipses-outline',
  };
  const name = map[routeName];
  if (!name) return null;
  return <Ionicons name={name} size={ICON_SIZE} color={color} />;
}

function SellTabButton({ onPress, accessibilityState, accessibilityLabel, testID }) {
  const focused = accessibilityState?.selected;

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={accessibilityLabel ?? 'Sell'}
      testID={testID}
      onPress={onPress}
      activeOpacity={0.9}
      style={styles.sellTabSlot}
    >
      <LinearGradient
        colors={SELL_RING_COLORS}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.sellRing}
      >
        <View style={styles.sellInner}>
          <Ionicons name="add" size={28} color={ACTIVE} />
        </View>
      </LinearGradient>
      <Text
        style={[
          styles.tabLabel,
          styles.sellLabel,
          focused ? styles.tabLabelActive : styles.tabLabelInactive,
        ]}
      >
        Sell
      </Text>
    </TouchableOpacity>
  );
}

const MainTabNavigator = () => {
  const insets = useSafeAreaInsets();
  const { unreadCount: chatUnread } = useChatUnread();
  const bottomPad = Math.max(insets.bottom, Platform.OS === 'ios' ? 10 : 8);
  const tabBarHeight = 68 + bottomPad;
  const fabBottom = tabBarHeight + 10;
  const chatBadge =
    chatUnread > 0 ? (chatUnread > 99 ? '99+' : chatUnread) : undefined;

  return (
    <View style={styles.tabRoot}>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarActiveTintColor: ACTIVE,
          tabBarInactiveTintColor: INACTIVE,
          tabBarStyle: [
            styles.tabBar,
            {
              height: tabBarHeight,
              paddingBottom: bottomPad,
            },
          ],
          tabBarLabelStyle: styles.tabLabel,
          tabBarIcon: ({ focused, color }) => (
            <TabBarIcon routeName={route.name} focused={focused} color={color} />
          ),
        })}
      >
        <Tab.Screen name="Home" component={HomeScreen} options={{ tabBarLabel: 'Home' }} />
        <Tab.Screen name="MyOrders" component={MyOrdersScreen} options={{ tabBarLabel: 'Orders' }} />
        <Tab.Screen
          name="Sell"
          component={CreateScreen}
          options={{
            tabBarLabel: () => null,
            tabBarIcon: () => null,
            tabBarButton: (props) => <SellTabButton {...props} />,
          }}
        />
        <Tab.Screen name="MyBids" component={MyBidsScreen} options={{ tabBarLabel: 'My Bids' }} />
        <Tab.Screen
          name="Chats"
          component={ChatListScreen}
          options={{
            tabBarLabel: 'Chats',
            tabBarBadge: chatBadge,
            tabBarBadgeStyle: styles.chatTabBadge,
          }}
        />
      </Tab.Navigator>
      <BidifyAIFab bottom={fabBottom} />
    </View>
  );
};

const styles = StyleSheet.create({
  tabRoot: {
    flex: 1,
  },
  tabBar: {
    backgroundColor: TAB_BG,
    borderTopWidth: 0,
    paddingTop: 10,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.25,
        shadowRadius: 8,
      },
      android: { elevation: 12 },
      default: {},
    }),
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.1,
    marginTop: 4,
  },
  tabLabelActive: {
    color: ACTIVE,
    fontWeight: '700',
  },
  tabLabelInactive: {
    color: INACTIVE,
    fontWeight: '500',
  },
  sellTabSlot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingTop: 22,
    paddingBottom: 2,
  },
  sellLabel: {
    marginTop: 6,
  },
  sellRing: {
    position: 'absolute',
    top: -12,
    width: 55,
    height: 55,
    borderRadius: 28,
    padding: 4,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 8,
      },
      android: { elevation: 8 },
    }),
  },
  sellInner: {
    width: 47,
    height: 47,
    borderRadius: 24,
    backgroundColor: TAB_BG,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatTabBadge: {
    backgroundColor: '#EF4444',
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
    minWidth: 18,
    height: 18,
    lineHeight: 18,
    borderRadius: 9,
  },
});

export default MainTabNavigator;
