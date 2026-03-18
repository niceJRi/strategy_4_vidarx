import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  private readonly adminEmail = process.env.ADMIN_EMAIL || '';
  private readonly adminPassword = process.env.ADMIN_PASSWORD || '';

  constructor(private readonly jwtService: JwtService) {}

  validateCredentials(email: string, password: string): boolean {
    if (!this.adminEmail || !this.adminPassword) {
      return false;
    }
    return email === this.adminEmail && password === this.adminPassword;
  }

  createAccessToken(email: string): string {
    return this.jwtService.sign({ sub: email }, { expiresIn: '1d' });
  }
}
