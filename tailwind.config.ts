import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Liquid Glass color palette - no pure black/grey/blue
        glass: {
          bg: 'rgba(18, 18, 18, 0.72)',
          border: 'rgba(255, 255, 255, 0.12)',
          borderStrong: 'rgba(255, 255, 255, 0.22)',
          highlight: 'rgba(255, 255, 255, 0.08)',
          // No text is full white; the brightest level is the same 66% veil the
          // settings subtitle wears. Kept in step with `--glass-text`.
          text: 'rgba(255, 255, 255, 0.66)',
          textMuted: 'rgba(255, 255, 255, 0.46)',
          textDim: 'rgba(255, 255, 255, 0.35)',
        },
        accent: {
          primary: '#e8b4b4',
          primaryHover: '#f0c8c8',
          secondary: '#c8d8e8',
          tertiary: '#d8e8c8',
        },
      },
      fontFamily: {
        heading: ['SF Pro Rounded', 'system-ui', 'sans-serif'],
        body: ['Cocon', 'SF Pro Rounded', 'system-ui', 'sans-serif'],
        display: ['SF Pro Rounded', 'system-ui', 'sans-serif'],
      },
      backdropBlur: {
        xs: '4px',
        sm: '8px',
        md: '16px',
        lg: '28px',
        xl: '40px',
        '2xl': '60px',
        '3xl': '80px',
      },
      boxShadow: {
        'glass': 'inset 0 1px 1px 0 rgba(255, 255, 255, 0.6), inset 0 -1px 2px 0 rgba(255, 255, 255, 0.15), 0 16px 40px -8px rgba(0, 0, 0, 0.45)',
        'glass-inner': 'inset 0 1px 1px 0 rgba(255, 255, 255, 0.6), inset 0 -1px 2px 0 rgba(255, 255, 255, 0.15)',
        'glass-strong': 'inset 0 1px 1px 0 rgba(255, 255, 255, 0.7), inset 0 -1px 2px 0 rgba(255, 255, 255, 0.2), 0 24px 60px -12px rgba(0, 0, 0, 0.55)',
        'glow': '0 0 24px rgba(232, 180, 180, 0.4), 0 0 48px rgba(232, 180, 180, 0.2)',
        'glow-subtle': '0 0 12px rgba(232, 180, 180, 0.25), 0 0 24px rgba(232, 180, 180, 0.15)',
      },
      borderRadius: {
        'pill': '9999px',
        'card': '24px',
        'card-sm': '16px',
        'card-lg': '32px',
      },
      transitionDuration: {
        'fast': '150ms',
        'normal': '250ms',
        'slow': '400ms',
        'spring': '600ms',
      },
      transitionTimingFunction: {
        'spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        'ease-out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-down': 'slideDown 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'scale-in': 'scaleIn 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'pulse-glow': 'pulseGlow 3s ease-in-out infinite',
        'shimmer': 'shimmer 2s linear infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideDown: {
          '0%': { opacity: '0', transform: 'translateY(-12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        pulseGlow: {
          '0%, 100%': { boxShadow: '0 0 16px rgba(232, 180, 180, 0.25)' },
          '50%': { boxShadow: '0 0 32px rgba(232, 180, 180, 0.45), 0 0 48px rgba(232, 180, 180, 0.25)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
};

export default config;