import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Platform,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { spacing } from '../theme';
import { useChatbotPanel } from '../context/ChatbotPanelContext';

const SCREEN_BG = '#F4F6F8';
const INDIGO = '#1E3A8A';
const SUPPORT_EMAIL = 'support@bidify.app';

const SECTIONS = [
  {
    id: 'how',
    title: 'How Bidify Works',
    icon: 'information-circle-outline',
    body:
      'Bidify is a trusted marketplace for antiques, collectibles, and curated goods. Browse live auctions on Home, shop fixed-price listings on Explore, and connect with sellers through secure in-app chat.\n\nCreate a listing from the Sell tab, verify your identity once, and fund your wallet to participate in auctions. Our platform holds bid amounts in escrow until an auction ends, protecting both buyers and sellers.',
  },
  {
    id: 'bidding',
    title: 'Bidding Rules',
    icon: 'hammer-outline',
    body:
      '• You must maintain the minimum wallet balance required to place bids.\n\n• Each bid must exceed the current highest bid by the platform minimum increment.\n\n• Winning bids are held in escrow until the auction resolves.\n\n• If you are outbid, held funds are released back to your available wallet balance.\n\n• Sellers may not bid on their own listings. Shill bidding or manipulation results in account suspension.',
  },
  {
    id: 'escrow',
    title: 'Escrow & Payments',
    icon: 'shield-checkmark-outline',
    body:
      'Wallet top-ups support secure payment methods configured for your region. When you place a bid, the required hold is deducted from your spendable balance and tracked separately as held funds.\n\nAfter an auction ends, the winning bidder\'s hold is applied toward checkout while other participants receive automatic releases. Buy-now (standard) listings are arranged directly with the seller via chat—no automated checkout unless shown on the listing.',
  },
  {
    id: 'contact',
    title: 'Contact Us',
    icon: 'mail-outline',
    body: `Our support team is available Monday–Saturday, 9:00 AM – 6:00 PM (PKT).\n\nEmail: ${SUPPORT_EMAIL}\n\nFor account, payment, or dispute issues, include your Bidify User ID and a brief description. We aim to respond within one business day.`,
  },
];

function AccordionItem({ section, expanded, onToggle }) {
  return (
    <View style={styles.accordionWrap}>
      <TouchableOpacity style={styles.accordionHeader} onPress={onToggle} activeOpacity={0.85}>
        <View style={styles.accordionIconWrap}>
          <Ionicons name={section.icon} size={20} color={INDIGO} />
        </View>
        <Text style={styles.accordionTitle}>{section.title}</Text>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={18}
          color="#94A3B8"
        />
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.accordionBody}>
          <Text style={styles.accordionText}>{section.body}</Text>
          {section.id === 'contact' ? (
            <TouchableOpacity
              style={styles.emailBtn}
              onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}
              activeOpacity={0.88}
            >
              <Ionicons name="mail-outline" size={18} color={INDIGO} />
              <Text style={styles.emailBtnText}>{SUPPORT_EMAIL}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const HelpSupportScreen = () => {
  const { open: openChatbot } = useChatbotPanel();
  const [expandedId, setExpandedId] = useState('how');

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.heroCard}>
          <Ionicons name="help-buoy-outline" size={32} color={INDIGO} />
          <Text style={styles.heroTitle}>How can we help?</Text>
          <Text style={styles.heroSub}>
            Answers to common questions about bidding, payments, and your account.
          </Text>
        </View>

        <TouchableOpacity
          style={styles.aiCard}
          onPress={openChatbot}
          activeOpacity={0.9}
        >
          <View style={styles.aiIconWrap}>
            <Ionicons name="sparkles" size={24} color="#FFFFFF" />
          </View>
          <View style={styles.aiTextWrap}>
            <Text style={styles.aiTitle}>Chat with Bidify AI</Text>
            <Text style={styles.aiSub}>
              Instant answers about bidding, wallet, and your account — 24/7.
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={22} color="#FFFFFF" />
        </TouchableOpacity>

        <View style={styles.card}>
          {SECTIONS.map((section, index) => (
            <React.Fragment key={section.id}>
              <AccordionItem
                section={section}
                expanded={expandedId === section.id}
                onToggle={() =>
                  setExpandedId((prev) => (prev === section.id ? null : section.id))
                }
              />
              {index < SECTIONS.length - 1 ? <View style={styles.divider} /> : null}
            </React.Fragment>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

const cardShadow = Platform.select({
  ios: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
  },
  android: { elevation: 2 },
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: SCREEN_BG },
  scroll: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: 48,
  },
  heroCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: spacing.xl,
    alignItems: 'center',
    marginBottom: spacing.lg,
    ...cardShadow,
  },
  heroTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0F172A',
    marginTop: spacing.md,
  },
  heroSub: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: 20,
  },
  aiCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: INDIGO,
    borderRadius: 16,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    gap: spacing.md,
    ...Platform.select({
      ios: {
        shadowColor: INDIGO,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.25,
        shadowRadius: 10,
      },
      android: { elevation: 4 },
    }),
  },
  aiIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiTextWrap: { flex: 1 },
  aiTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: -0.2,
  },
  aiSub: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.88)',
    marginTop: 4,
    lineHeight: 18,
    fontWeight: '500',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingVertical: spacing.sm,
    ...cardShadow,
  },
  accordionWrap: { paddingHorizontal: spacing.lg },
  accordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  accordionIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  accordionTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    color: '#0F172A',
  },
  accordionBody: {
    paddingBottom: spacing.md,
    paddingLeft: 56,
  },
  accordionText: {
    fontSize: 14,
    color: '#475569',
    lineHeight: 22,
  },
  emailBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: spacing.md,
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#EEF2FF',
    borderRadius: 10,
  },
  emailBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: INDIGO,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#E2E8F0',
    marginHorizontal: spacing.lg,
  },
});

export default HelpSupportScreen;
